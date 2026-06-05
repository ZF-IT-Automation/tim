// TIM MCP — extended tim_read / tim_search / tim_write integration tests

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
    const results = JSON.parse(resp.result!.content[0].text);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r: { title: string }) => r.title === 'AlphaSearchToken')).toBe(true);
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
    const hitResults = JSON.parse(hit.result!.content[0].text);
    expect(hitResults).toHaveLength(1);
    expect(hitResults[0].title).toBe('Errmark');

    const miss = await client.callTool('tim_search', {
      query: 'Rulemark',
      type: 'error',
      tag: 'combo',
      status: 'todo',
    });
    const missResults = JSON.parse(miss.result!.content[0].text);
    expect(missResults).toHaveLength(0);
  });
});
