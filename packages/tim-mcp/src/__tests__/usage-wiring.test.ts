// TIM MCP — usage feedback wiring integration tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import Database from 'better-sqlite3';

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
      env: { ...process.env, TIM_DB_PATH: dbPath, TIM_SESSION_ID: 'usage-test-session' },
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

  async initialize(): Promise<void> {
    if (this.ready) return;
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'usage-wiring-test', version: '0.0.1' },
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResp> {
    await this.initialize();
    return this.send('tools/call', { name, arguments: args });
  }

  kill(): void {
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (!this.proc.killed) this.proc.kill('SIGKILL');
    }, 100);
  }
}

describe('usage wiring through MCP handlers', () => {
  let dir: string;
  let dbPath: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-usage-'));
    dbPath = path.join(dir, 'test.db');
    client = new McpClient(dbPath);
    await client.initialize();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function usageRows(): Array<{ entry_id: string; session_id: string; referenced: number }> {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare('SELECT entry_id, session_id, referenced FROM entry_usage').all() as never;
    } finally {
      db.close();
    }
  }

  it('tim_read records a read; tim_update marks it referenced', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Usage fact\nBody.', tags: ['#a', '#b'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const entryId = entry.id ?? entry.entry?.id;

    await client.callTool('tim_read', { id: entryId });
    let rows = usageRows().filter(r => r.entry_id === entryId);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced).toBe(0);

    await client.callTool('tim_update', { id: entryId, content: 'Usage fact\nEdited.' });
    rows = usageRows().filter(r => r.entry_id === entryId);
    expect(rows.some(r => r.referenced === 1)).toBe(true);
  });

  it('tim_update via label marks the resolved entry referenced after label read', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Label usage fact\nBody.',
      tags: ['#a', '#b'],
      metadata: { label: 'L7701' },
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const compositeId = entry.id ?? entry.entry?.id;
    expect(compositeId).not.toBe('L7701');

    await client.callTool('tim_read', { id: 'L7701' });
    let rows = usageRows().filter(r => r.entry_id === compositeId);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced).toBe(0);

    await client.callTool('tim_update', { id: 'L7701', content: 'Label usage fact\nEdited.' });
    rows = usageRows().filter(r => r.entry_id === compositeId);
    expect(rows.some(r => r.referenced === 1)).toBe(true);
  });

  it('tim_search results are recorded as reads', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Searchable usage fact\nBody.', tags: ['#a', '#b'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const entryId = entry.id ?? entry.entry?.id;

    await client.callTool('tim_search', { query: 'searchable usage' });
    expect(usageRows().some(r => r.entry_id === entryId)).toBe(true);
  });
});
