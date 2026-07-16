import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';
import Database from 'better-sqlite3';
import { runMigrations } from 'tim-store';
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
  private ready = false;

  constructor(dbPath: string) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      cwd: childServerCwd(),
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
      clientInfo: { name: 'tag-deprecation', version: '0.0.1' },
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

function parseWriteResult(text: string): { entry: { id: string; tags: string[] }; warnings?: string[] } {
  const parsed = JSON.parse(text);
  if (parsed.entry) return parsed;
  return { entry: parsed };
}

describe('tag deprecation (Schema v3 Phase 3)', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-tag-dep-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('tim_write with status tags strips them and returns warnings', async () => {
    const resp = await client.callTool('tim_write', {
      content: 'Status tag test',
      tags: ['#todo', '#done', '#tim', '#security'],
      metadata: { type: 'task', task: { status: 'todo', priority: 'medium' } },
    });
    const { entry, warnings } = parseWriteResult(resp.result!.content[0].text);

    expect(entry.tags).not.toContain('#todo');
    expect(entry.tags).not.toContain('#done');
    expect(entry.tags).toEqual(expect.arrayContaining(['#tim', '#security']));
    expect(warnings).toBeDefined();
    expect(warnings!.length).toBeGreaterThanOrEqual(2);
    expect(warnings!.some(w => w.includes('#todo'))).toBe(true);
  });

  it('tim_write with only topic tags stores them normally', async () => {
    const resp = await client.callTool('tim_write', {
      content: 'Topic only',
      tags: ['#tim', '#security'],
      metadata: { type: 'task', task: { status: 'todo' } },
    });
    const parsed = JSON.parse(resp.result!.content[0].text);

    expect(parsed.tags).toEqual(['#tim', '#security']);
    expect(parsed.warnings).toBeUndefined();
  });

  it('tim_write with mixed tags keeps only topic tags', async () => {
    const resp = await client.callTool('tim_write', {
      content: 'Mixed tags',
      tags: ['#in_progress', '#priority-high', '#tim', '#feature'],
      metadata: { type: 'task', task: { status: 'in_progress', priority: 'high' } },
    });
    const { entry } = parseWriteResult(resp.result!.content[0].text);

    expect(entry.tags).toEqual(['#tim', '#feature']);
    expect(entry.tags).not.toContain('#in_progress');
    expect(entry.tags).not.toContain('#priority-high');
  });

  it('tim_tag_add with status tag skips it and returns warning', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'For tag add',
      tags: ['#tim', '#test'],
      metadata: { type: 'task', task: { status: 'todo' } },
    });
    const { entry: written } = parseWriteResult(writeResp.result!.content[0].text);

    const addResp = await client.callTool('tim_tag_add', {
      id: written.id,
      tags: ['#done'],
    });
    const parsed = JSON.parse(addResp.result!.content[0].text);

    expect(parsed.entry.tags).not.toContain('#done');
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.some((w: string) => w.includes('#done'))).toBe(true);
  });

  it('tim_tag_add with topic tag adds normally', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'For topic add',
      tags: ['#tim', '#test'],
      metadata: { type: 'task', task: { status: 'todo' } },
    });
    const { entry: written } = parseWriteResult(writeResp.result!.content[0].text);

    const addResp = await client.callTool('tim_tag_add', {
      id: written.id,
      tags: ['#security'],
    });
    const parsed = JSON.parse(addResp.result!.content[0].text);
    const result = parsed.entry ?? parsed;

    expect(result.tags).toContain('#security');
    expect(parsed.warnings).toBeUndefined();
  });

  it('tim_update strips deprecated tags from patch', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'For update',
      tags: ['#tim', '#test'],
      metadata: { type: 'task', task: { status: 'todo' } },
    });
    const { entry: written } = parseWriteResult(writeResp.result!.content[0].text);

    const updateResp = await client.callTool('tim_update', {
      id: written.id,
      tags: ['#cancelled', '#security', '#feature'],
    });
    const parsed = JSON.parse(updateResp.result!.content[0].text);
    const entry = parsed.entry ?? parsed;

    expect(entry.tags).not.toContain('#cancelled');
    expect(entry.tags).toEqual(expect.arrayContaining(['#security', '#feature']));
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.some((w: string) => w.includes('#cancelled'))).toBe(true);
  });

  it('existing entries with status tags remain readable (backward compat)', async () => {
    const db = new Database(dbPath);
    runMigrations(db);
    const now = new Date().toISOString();
    const id = 'LEGACYTAG1';
    db.prepare(`INSERT INTO entries
      (id, parent_id, title, content, content_type, depth, confidence, created_at,
       accessed_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata)
      VALUES (?, NULL, 'Legacy tags', 'body', 'text', 1, 1, ?, ?, 0, 1, ?, 0, 0, NULL, ?)`).run(
      id,
      now,
      now,
      JSON.stringify(['#todo', '#tim', '#security']),
      JSON.stringify({ type: 'task', task: { status: 'todo' } }),
    );
    db.close();

    const readResp = await client.callTool('tim_read', { id });
    const parsed = JSON.parse(readResp.result!.content[0].text);

    expect(parsed.entry.tags).toContain('#todo');
    expect(parsed.entry.tags).toContain('#tim');
    expect(parsed.entry.tags).toContain('#security');
  });

  it('topic tags work normally on write and read', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'Topic tags roundtrip',
      tags: ['#tim', '#security'],
      metadata: { type: 'learning' },
    });
    const parsed = JSON.parse(writeResp.result!.content[0].text);
    const entry = parsed.entry ?? parsed;

    const readResp = await client.callTool('tim_read', { id: entry.id });
    const readParsed = JSON.parse(readResp.result!.content[0].text);

    expect(readParsed.entry.tags).toEqual(['#tim', '#security']);
  });
});
