import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';

isolateChildServerCwd();

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

interface JsonRpcResp {
  id: number;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (resp: JsonRpcResp) => void>();
  private buffer = '';

  constructor(dbPath: string) {
    this.proc = spawn('node', [SERVER_PATH], {
      cwd: childServerCwd(),
      env: { ...process.env, TIM_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', chunk => this.onData(chunk.toString('utf8')));
    this.proc.stderr!.on('data', () => {});
  }

  private onData(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResp;
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      } catch { /* ignore non-json lines */ }
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async init(): Promise<void> {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  async health(): Promise<Record<string, unknown>> {
    await this.init();
    const resp = await this.send('tools/call', { name: 'tim_health', arguments: {} });
    expect(resp.error).toBeUndefined();
    return JSON.parse(resp.result!.content[0].text) as Record<string, unknown>;
  }

  async doctor(): Promise<string> {
    await this.init();
    const resp = await this.send('tools/call', { name: 'tim_doctor', arguments: {} });
    expect(resp.error).toBeUndefined();
    return resp.result!.content[0].text;
  }

  close(): void {
    this.proc.kill('SIGTERM');
  }
}

describe('tim_health memory diagnostics (MCP)', () => {
  let root: string;
  let dbPath: string;
  let client: McpClient;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join('/tmp', 'tim-mcp-mem-health-'));
    dbPath = path.join(root, 'tim.db');
    client = new McpClient(dbPath);
  });

  afterEach(() => {
    client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns additive memory field on empty database', async () => {
    const report = await client.health();
    const memory = report.memory as Record<string, unknown>;
    expect(memory).toBeDefined();
    const summary = memory.summaryCoverage as Record<string, unknown>;
    expect(summary.workState).toBe('no_sessions');
    expect(summary.observedExchangeCount).toBe(0);
  });

  it('tim_doctor includes memory coverage lines', async () => {
    const text = await client.doctor();
    expect(text).toContain('Memory exchanges:');
    expect(text).toContain('Semantic index:');
  });
});
