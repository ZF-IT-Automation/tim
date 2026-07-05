import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import os from 'node:os';

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

  constructor(dbPath: string) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
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
      clientInfo: { name: 'summary-test', version: '0.0.1' },
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

describe('summary-first reads', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-summary-'));
    client = new McpClient(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns summary by default (first 500 chars)', async () => {
    const longBody = 'A'.repeat(2000);
    const w = await client.callTool('tim_write', {
      content: `Test Entry\n${longBody}`,
      tags: ['#test', '#summary'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const id = entry.id ?? entry.entry?.id;

    const r = await client.callTool('tim_read', { id });
    const body = JSON.parse(r.result!.content[0].text);
    expect(body.entry.summary).toBeDefined();
    expect(body.entry.summary.length).toBeLessThanOrEqual(500);
    expect(body.entry.content).toBeUndefined();
  });

  it('returns full body with include_body=true', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Entry\nFull body here.',
      tags: ['#test', '#summary'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const id = entry.id ?? entry.entry?.id;

    const r = await client.callTool('tim_read', { id, include_body: true });
    const body = JSON.parse(r.result!.content[0].text);
    expect(body.entry.summary).toBeDefined();
    expect(body.entry.content).toContain('Full body here');
  });

  it('uses metadata.summary if set explicitly', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Entry\nReal body.',
      metadata: { summary: 'Custom summary text' },
      tags: ['#test', '#summary'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const id = entry.id ?? entry.entry?.id;

    const r = await client.callTool('tim_read', { id });
    const body = JSON.parse(r.result!.content[0].text);
    expect(body.entry.summary).toBe('Custom summary text');
  });
});
