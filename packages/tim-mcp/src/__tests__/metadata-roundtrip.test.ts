import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { TimStore, runMigrations } from 'tim-store';

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
      clientInfo: { name: 'meta-roundtrip', version: '0.0.1' },
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

describe('metadata boolean roundtrip', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-meta-rt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('tim_write + tim_read returns boolean task metadata', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'Task entry',
      tags: ['#task', '#test'],
      metadata: { task: true, status: 'todo' },
    });
    const written = JSON.parse(writeResp.result!.content[0].text);

    const readResp = await client.callTool('tim_read', { id: written.id });
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed.entry.metadata.task).toBe(true);
    expect(typeof parsed.entry.metadata.task).toBe('boolean');
  });

  it('tim_read coerces legacy task:1 stored in DB', async () => {
    const db = new Database(dbPath);
    runMigrations(db);
    const now = new Date().toISOString();
    const id = 'LEGACY01';
    db.prepare(`INSERT INTO entries
      (id, parent_id, title, content, content_type, depth, confidence, created_at,
       accessed_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata)
      VALUES (?, NULL, 'Legacy', 'body', 'text', 1, 1, ?, ?, 0, 1, '["#a","#b"]', 0, 0, NULL, ?)`).run(
      id,
      now,
      now,
      JSON.stringify({ task: 1, status: 'done' }),
    );
    db.close();

    const readResp = await client.callTool('tim_read', { id });
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed.entry.metadata.task).toBe(true);
    expect(typeof parsed.entry.metadata.task).toBe('boolean');
  });

  it('round-trips task false and nested metadata', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'Nested meta',
      tags: ['#task', '#nested'],
      metadata: {
        task: false,
        nested: { archived: 1, note: 'x' },
      },
    });
    const written = JSON.parse(writeResp.result!.content[0].text);

    const readResp = await client.callTool('tim_read', { id: written.id });
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed.entry.metadata.task).toBe(false);
    expect(parsed.entry.metadata.nested.archived).toBe(true);
    expect(typeof parsed.entry.metadata.nested.archived).toBe('boolean');
  });

  it('store.update with pre-coerced metadata persists boolean task', async () => {
    const store = new TimStore(dbPath);
    const entry = await store.write('Seed', {
      tags: ['#a', '#b'],
      metadata: { task: true },
    });
    await store.update(entry.id, { metadata: { task: true, status: 'done' } });
    const read = await store.read(entry.id);
    expect(read!.metadata.task).toBe(true);
    expect(typeof read!.metadata.task).toBe('boolean');

    const row = store.getDb().prepare('SELECT metadata FROM entries WHERE id = ?').get(entry.id) as {
      metadata: string;
    };
    const stored = JSON.parse(row.metadata);
    expect(stored.task).toBe(true);
    store.close();
  });
});
