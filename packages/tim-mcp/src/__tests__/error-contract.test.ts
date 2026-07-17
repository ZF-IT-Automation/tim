// TIM MCP — error contract: every failure path returns isError:true, never text "null".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { isolatedCwd } from './test-helpers/mcp-client.js';
import * as fs from 'node:fs';

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
  private ready = false;

  constructor(dbPath: string, cwd?: string) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      // Never inherit the runner cwd — the server syncs .tim-project markers there.
      cwd: cwd ?? isolatedCwd(),
      env: { ...process.env, TIM_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (chunk) => this.onData(chunk.toString('utf8')));
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
      } catch {
        // ignore
      }
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 10000);
      this.pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      this.proc.stdin!.write(frame);
    });
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'error-contract-test', version: '0.0.1' },
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResp> {
    await this.init();
    return this.send('tools/call', { name, arguments: args });
  }

  kill(): void {
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (!this.proc.killed) this.proc.kill('SIGKILL');
    }, 100);
  }
}

function getText(resp: JsonRpcResp): string {
  return resp.result!.content[0].text;
}

describe('error contract', () => {
  let client: McpClient;
  let dbPath: string;
  let cwdDir: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-err-contract-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    // Self-contained marker cwd: the load-gate needs a session id resolvable
    // from the server cwd — never depend on a repo-checkout .tim-project.
    cwdDir = isolatedCwd({ session: 'err-contract-session' });
    client = new McpClient(dbPath, cwdDir);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('tim_read of a missing id returns isError with a helpful message, not "null"', async () => {
    const res = await client.callTool('tim_read', { id: 'NOPE-000' });
    expect(res.error).toBeUndefined();
    expect(res.result!.isError).toBe(true);
    const text = getText(res);
    expect(text).not.toBe('null');
    expect(text).toContain('NOPE-000');
  });

  it('tim_load_project of a missing project returns isError', async () => {
    const res = await client.callTool('tim_load_project', { label: 'P9999-DOES-NOT-EXIST' });
    expect(res.error).toBeUndefined();
    expect(res.result!.isError).toBe(true);
  });

  it('load-gate rejection returns isError when binding a second project', async () => {
    // Create two projects.
    const a = await client.callTool('tim_create_project', { label: 'P8001', content: 'A' });
    expect(a.error).toBeUndefined();
    const b = await client.callTool('tim_create_project', { label: 'P8002', content: 'B' });
    expect(b.error).toBeUndefined();

    // First load binds the session.
    const first = await client.callTool('tim_load_project', { label: 'P8001' });
    expect(first.error).toBeUndefined();
    expect(first.result!.isError).toBeFalsy();

    // Second load to a different project is rejected with isError.
    const second = await client.callTool('tim_load_project', { label: 'P8002' });
    expect(second.error).toBeUndefined();
    expect(second.result!.isError).toBe(true);
    expect(getText(second)).toContain('P8001');
  });

  it('tim_write without content returns isError (zod parse error)', async () => {
    const res = await client.callTool('tim_write', { parentId: 'whatever' });
    expect(res.error).toBeUndefined();
    expect(res.result!.isError).toBe(true);
  });
});