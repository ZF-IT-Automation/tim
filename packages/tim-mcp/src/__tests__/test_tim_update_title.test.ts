import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
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
      clientInfo: { name: 'test-tim-update-title', version: '0.0.1' },
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

function parseEntry(text: string): { id: string; title: string; content: string } {
  const parsed = JSON.parse(text);
  return parsed.entry ?? parsed;
}

describe('tim_update title param', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-update-title-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('updates title on first-line-as-title entry without changing content', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'AutoTitle\nBody stays',
      tags: ['#tim', '#test'],
    });
    const written = parseEntry(writeResp.result!.content[0].text);
    expect(written.title).toBe('AutoTitle');
    expect(written.content).toBe('Body stays');

    const updateResp = await client.callTool('tim_update', {
      id: written.id,
      title: 'New Title',
    });
    expect(updateResp.error).toBeUndefined();
    const updated = parseEntry(updateResp.result!.content[0].text);
    expect(updated.title).toBe('New Title');

    const readResp = await client.callTool('tim_read', { id: written.id });
    const readBack = parseEntry(readResp.result!.content[0].text);
    expect(readBack.title).toBe('New Title');
    expect(readBack.content).toBe('Body stays');
  });

  it('updates title on explicit-title entry without changing content', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'Body text',
      title: 'Original',
      tags: ['#tim', '#test'],
    });
    const written = parseEntry(writeResp.result!.content[0].text);

    const updateResp = await client.callTool('tim_update', {
      id: written.id,
      title: 'Updated',
    });
    const updated = parseEntry(updateResp.result!.content[0].text);
    expect(updated.title).toBe('Updated');
    expect(updated.content).toBe('Body text');

    const readResp = await client.callTool('tim_read', { id: written.id });
    const readBack = parseEntry(readResp.result!.content[0].text);
    expect(readBack.title).toBe('Updated');
    expect(readBack.content).toBe('Body text');
  });
});
