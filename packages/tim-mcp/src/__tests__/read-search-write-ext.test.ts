// TIM MCP — extended tim_read / tim_search / tim_write integration tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';
import { TimStore } from 'tim-store';
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
      clientInfo: { name: 'ext-test', version: '0.0.1' },
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

describe('tim_read extended', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-read-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('single string id returns {entry,edges} shape unchanged', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'Read me',
      tags: ['#note', '#test'],
    });
    const written = JSON.parse(writeResp.result!.content[0].text);

    const readResp = await client.callTool('tim_read', { id: written.id });
    expect(readResp.error).toBeUndefined();
    expect(readResp.result?.isError).toBeFalsy();
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed).toHaveProperty('entry');
    expect(parsed).toHaveProperty('edges');
    expect(Array.isArray(parsed.edges)).toBe(true);
    expect(parsed.entry.id).toBe(written.id);
  });

  it('array id returns {entries,missing} with missing reported', async () => {
    const w1 = await client.callTool('tim_write', {
      content: 'One',
      tags: ['#note', '#test'],
    });
    const e1 = JSON.parse(w1.result!.content[0].text);

    const readResp = await client.callTool('tim_read', {
      id: [e1.id, 'missing-ulid-123'],
    });
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].id).toBe(e1.id);
    expect(parsed.missing).toEqual(['missing-ulid-123']);
  });

  it('rejects batch id arrays larger than 50', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    const readResp = await client.callTool('tim_read', { id: ids });
    expect(readResp.result?.isError).toBe(true);
    expect(readResp.result!.content[0].text).toMatch(/50|too big|maximum/i);
  });

  it('project reads project entry by label', async () => {
    await client.callTool('tim_create_project', { label: 'P0500', content: 'Read Project' });
    const readResp = await client.callTool('tim_read', { project: 'P0500' });
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed.entry.metadata.label).toBe('P0500');
    expect(parsed.entry.metadata.kind).toBe('project');
  });

  it('section returns section and children', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P0501', content: 'Section Proj' });
    const project = JSON.parse(proj.result!.content[0].text);
    const secWrite = await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const section = JSON.parse(secWrite.result!.content[0].text);
    await client.callTool('tim_write', {
      content: 'Child task',
      parentId: section.id,
      tags: ['#task', '#test'],
    });

    const readResp = await client.callTool('tim_read', {
      project: 'P0501',
      section: 'Tasks',
    });
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed.section.title).toBe('Tasks');
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0].title).toBe('Child task');
  });
});

describe('tim_search extended', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-search-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  async function seedScopedEntry(
    label: string,
    content: string,
    tags: string[],
    meta: Record<string, unknown> = {},
  ) {
    const proj = await client.callTool('tim_create_project', { label, content: `${label} Proj` });
    const project = JSON.parse(proj.result!.content[0].text);
    const section = await client.callTool('tim_write', {
      content: 'Notes',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const sec = JSON.parse(section.result!.content[0].text);
    await client.callTool('tim_write', {
      content,
      parentId: sec.id,
      tags,
      metadata: meta,
    });
  }

  it('root scopes search to project', async () => {
    await seedScopedEntry('P0510', 'AlphaSearchToken', ['#note', '#test']);
    await seedScopedEntry('P0511', 'AlphaSearchToken', ['#note', '#test']);

    const resp = await client.callTool('tim_search', {
      query: 'AlphaSearchToken',
      root: 'P0510',
    });
    const response = JSON.parse(resp.result!.content[0].text);
    expect(response.results.length).toBeGreaterThanOrEqual(1);
    expect(response.results.every((r: { title: string }) => r.title === 'AlphaSearchToken')).toBe(true);
  });

  it('type tag status filters combine with AND', async () => {
    await seedScopedEntry('P0520', 'Errmark', ['#combo', '#test'], {
      type: 'error',
      status: 'todo',
    });
    await seedScopedEntry('P0521', 'Rulemark', ['#combo', '#test'], {
      type: 'rule',
      status: 'todo',
    });

    const hit = await client.callTool('tim_search', {
      query: 'Errmark',
      type: 'error',
      tag: 'combo',
      status: 'todo',
    });
    const hitResponse = JSON.parse(hit.result!.content[0].text);
    expect(hitResponse.results).toHaveLength(1);
    expect(hitResponse.results[0].title).toBe('Errmark');

    const miss = await client.callTool('tim_search', {
      query: 'Rulemark',
      type: 'error',
      tag: 'combo',
      status: 'todo',
    });
    const missResponse = JSON.parse(miss.result!.content[0].text);
    expect(missResponse.results).toHaveLength(0);
  });

  it('rejects requested excerpts above 500 Unicode code points', async () => {
    client.kill();
    const store = new TimStore(dbPath);
    try {
      await store.write(`ExcerptCapNeedle\n${'😀'.repeat(1_000)}`);
    } finally {
      store.close();
    }
    client = new McpClient(dbPath);
    await client.init();

    const result = await client.callTool('tim_search', {
      query: 'ExcerptCapNeedle',
      excerptChars: 501,
    });

    expect(result.result?.isError).toBe(true);
    expect(result.result?.content[0].text).toContain('500');
  });

  it('marks a shortened excerpt truncated when no results are omitted', async () => {
    client.kill();
    const store = new TimStore(dbPath);
    try {
      await store.write(`ExcerptFlagNeedle\n${'😀'.repeat(1_000)}`);
    } finally {
      store.close();
    }
    client = new McpClient(dbPath);
    await client.init();

    const result = await client.callTool('tim_search', {
      query: 'ExcerptFlagNeedle',
    });
    const response = JSON.parse(result.result!.content[0].text);

    expect(response.returned).toBe(1);
    expect(response.omitted).toBe(0);
    expect(response.truncated).toBe(true);
  });

  it('bounds 100 huge Unicode results to 24 KiB with stable order and counters', async () => {
    client.kill();
    const store = new TimStore(dbPath);
    const ids: string[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const bodySize = 20_000 + (i % 9) * 10_000;
        const entry = await store.write(
          `BoundedNeedle ${String(i).padStart(3, '0')}\n${'😀'.repeat(bodySize / 2)}`,
          {
            tags: ['#bounded', `#item-${i}`],
            metadata: {
              kind: i === 0 ? 'project' : 'note',
              label: i === 0 ? 'P0777' : undefined,
              type: i % 2 === 0 ? 'learning' : 'note',
              status: i % 3 === 0 ? 'active' : 'done',
              project_ref: 'P0777',
              task: { status: 'open', priority: i % 5 },
              secret_field: 'must-not-leak',
            },
          },
        );
        ids.push(entry.id);
      }
    } finally {
      store.close();
    }
    client = new McpClient(dbPath);
    await client.init();

    const first = await client.callTool('tim_search', {
      query: 'BoundedNeedle',
      topK: 100,
    });
    const second = await client.callTool('tim_search', {
      query: 'BoundedNeedle',
      topK: 100,
    });
    const firstText = first.result!.content[0].text;
    const response = JSON.parse(firstText);
    const responseAgain = JSON.parse(second.result!.content[0].text);

    expect(Buffer.byteLength(firstText, 'utf8')).toBeLessThanOrEqual(24 * 1024);
    expect(response.returned).toBe(response.results.length);
    expect(response.omitted).toBe(100 - response.returned);
    expect(response.truncated).toBe(true);
    expect(response.returned).toBeGreaterThan(0);
    expect(response.results.map((r: { id: string }) => r.id)).toEqual(
      responseAgain.results.map((r: { id: string }) => r.id),
    );

    for (const result of response.results) {
      expect(Array.from(result.excerpt).length).toBeLessThanOrEqual(500);
      expect(result.excerpt.endsWith('…')).toBe(true);
      expect(Object.keys(result.metadata).sort()).toEqual(
        ['kind', 'label', 'project_ref', 'status', 'task', 'type']
          .filter(key => result.metadata[key] !== undefined)
          .sort(),
      );
      expect(result.metadata.secret_field).toBeUndefined();
    }

    const read = await client.callTool('tim_read', { id: ids[0], include_body: true });
    const full = JSON.parse(read.result!.content[0].text);
    expect(Array.from(full.entry.content).length).toBeGreaterThan(500);
  }, 30_000);
});

describe('tim_write where shorthand', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-write-where-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('where P0062/Tasks resolves project and section parent', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P0600', content: 'Where Proj' });
    const project = JSON.parse(proj.result!.content[0].text);
    await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });

    const writeResp = await client.callTool('tim_write', {
      content: 'Task via where',
      where: 'P0600/Tasks',
      metadata: { task: true, status: 'todo' },
      tags: ['#task', '#test'],
    });
    expect(writeResp.error).toBeUndefined();
    expect(writeResp.result?.isError).toBeFalsy();
    const written = JSON.parse(writeResp.result!.content[0].text);

    const readResp = await client.callTool('tim_read', {
      project: 'P0600',
      section: 'Tasks',
    });
    const parsed = JSON.parse(readResp.result!.content[0].text);
    expect(parsed.children.some((c: { id: string }) => c.id === written.id)).toBe(true);
  });

  it('explicit parentId overrides where', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P0601', content: 'Override Proj' });
    const project = JSON.parse(proj.result!.content[0].text);
    const tasks = await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const tasksSec = JSON.parse(tasks.result!.content[0].text);
    const ideas = await client.callTool('tim_write', {
      content: 'Ideas',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const ideasSec = JSON.parse(ideas.result!.content[0].text);

    const writeResp = await client.callTool('tim_write', {
      content: 'Ideas child',
      where: 'P0601/Tasks',
      parentId: ideasSec.id,
      tags: ['#idea', '#test'],
    });
    const written = JSON.parse(writeResp.result!.content[0].text);

    const ideasRead = await client.callTool('tim_read', { project: 'P0601', section: 'Ideas' });
    const ideasParsed = JSON.parse(ideasRead.result!.content[0].text);
    expect(ideasParsed.children.some((c: { id: string }) => c.id === written.id)).toBe(true);

    const tasksRead = await client.callTool('tim_read', { project: 'P0601', section: 'Tasks' });
    const tasksParsed = JSON.parse(tasksRead.result!.content[0].text);
    expect(tasksParsed.children.some((c: { id: string }) => c.id === written.id)).toBe(false);
    expect(tasksSec.id).not.toBe(ideasSec.id);
  });

  it('bad section in where returns clean error', async () => {
    await client.callTool('tim_create_project', { label: 'P0602', content: 'Bad Section Proj' });
    const writeResp = await client.callTool('tim_write', {
      content: 'Orphan attempt',
      where: 'P0602/NoSuchSection',
      tags: ['#note', '#test'],
    });
    expect(writeResp.result?.isError).toBe(true);
    expect(writeResp.result!.content[0].text).toContain('section not found');
  });

  it('parentTitle+projectId path still works (regression)', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P0603', content: 'Legacy Proj' });
    const project = JSON.parse(proj.result!.content[0].text);
    await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });

    const writeResp = await client.callTool('tim_write', {
      content: 'Legacy write',
      parentTitle: 'Tasks',
      projectId: 'P0603',
      tags: ['#task', '#test'],
    });
    expect(writeResp.error).toBeUndefined();
    expect(writeResp.result?.isError).toBeFalsy();
  });
});

describe('tim_show what=tasks (replaces deprecated tim_tasks)', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-show-tasks-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  async function seedTask(label: string, title: string, status: string) {
    const proj = await client.callTool('tim_create_project', { label, content: title });
    const project = JSON.parse(proj.result!.content[0].text);
    const section = await client.callTool('tim_write', {
      content: 'Next Steps',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const sec = JSON.parse(section.result!.content[0].text);
    await client.callTool('tim_write', {
      content: `${title} task`,
      parentId: sec.id,
      metadata: { task: true, status },
      tags: ['#task', '#test'],
    });
  }

  // Plan 4 Task 3 functional coverage for `tim_show what='tasks' with='done'`
  // lives in show-output.test.ts (with root='all') — this file only asserts
  // the migration boundary itself: tim_tasks is gone.

  it('tim_tasks is removed — call returns Unknown tool error', async () => {
    const resp = await client.callTool('tim_tasks', { status: 'done' });
    expect(resp.error).toBeUndefined();
    expect(resp.result!.isError).toBe(true);
    expect(resp.result!.content[0].text).toContain('Unknown tool');
  });
});
