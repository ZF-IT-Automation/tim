// TIM MCP — tim_show integration tests

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

  constructor(dbPath: string, extraEnv: Record<string, string> = {}) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      env: { ...process.env, TIM_DB_PATH: dbPath, ...extraEnv },
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
        // ignore non-JSON lines
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
      clientInfo: { name: 'show-test', version: '0.0.1' },
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

async function seedProjectWithTask(
  client: McpClient,
  label: string,
  title: string,
  taskTitle: string,
  taskMeta: Record<string, unknown> = {},
  taskTags: string[] = ['#task', '#todo'],
): Promise<void> {
  const proj = await client.callTool('tim_create_project', { label, content: title });
  expect(proj.error).toBeUndefined();
  const project = JSON.parse(proj.result!.content[0].text);

  const section = await client.callTool('tim_write', {
    content: 'Next Steps',
    parentId: project.id,
    metadata: { kind: 'section', label: 'Next Steps' },
    tags: ['#section', '#schema'],
  });
  expect(section.error).toBeUndefined();
  const sec = JSON.parse(section.result!.content[0].text);

  await client.callTool('tim_write', {
    content: taskTitle,
    parentId: sec.id,
    metadata: { task: true, status: 'todo', ...taskMeta },
    tags: taskTags,
  });
}

describe('tim_show', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-show-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('what:tasks with explicit root scopes to single project', async () => {
    await seedProjectWithTask(client, 'P0400', 'Active Proj', 'Active task');
    await seedProjectWithTask(client, 'P0401', 'Other Proj', 'Other task');

    const resp = await client.callTool('tim_show', { what: 'tasks', root: 'P0400' });
    expect(resp.error).toBeUndefined();
    expect(resp.result?.isError).toBeFalsy();
    const text = resp.result!.content[0].text;
    expect(text).toContain('Active task');
    expect(text).not.toContain('Other task');
  });

  it('what:tasks root:all groups tasks from multiple projects', async () => {
    await seedProjectWithTask(client, 'P0410', 'Alpha', 'Alpha task');
    await seedProjectWithTask(client, 'P0411', 'Beta', 'Beta task');

    const resp = await client.callTool('tim_show', { what: 'tasks', root: 'all' });
    expect(resp.error).toBeUndefined();
    const text = resp.result!.content[0].text;
    expect(text).toContain('P0410');
    expect(text).toContain('P0411');
    expect(text).toContain('Alpha task');
    expect(text).toContain('Beta task');
  });

  it('what:bugs returns only #bug tagged entries', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P0440', content: 'Bug Proj' });
    const project = JSON.parse(proj.result!.content[0].text);
    const section = await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const sec = JSON.parse(section.result!.content[0].text);

    await client.callTool('tim_write', {
      content: 'Real bug',
      parentId: sec.id,
      tags: ['#bug', '#test'],
    });
    await client.callTool('tim_write', {
      content: 'Not a bug',
      parentId: sec.id,
      tags: ['#note', '#test'],
    });

    const resp = await client.callTool('tim_show', { what: 'bugs', root: 'all' });
    const text = resp.result!.content[0].text;
    expect(text).toContain('Real bug');
    expect(text).not.toContain('Not a bug');
  });

  it('what:errors unions type=error and #error tag deduped', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P0441', content: 'Error Proj' });
    const project = JSON.parse(proj.result!.content[0].text);
    const section = await client.callTool('tim_write', {
      content: 'Errors',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const sec = JSON.parse(section.result!.content[0].text);

    for (const [content, meta] of [
      ['Typed error', { type: 'error' }],
      ['Tagged only', {}],
      ['Both signals', { type: 'error' }],
    ] as const) {
      const w = await client.callTool('tim_write', {
        content,
        parentId: sec.id,
        metadata: meta,
        tags: ['#error', '#test'],
      });
      expect(w.error).toBeUndefined();
      expect(w.result?.isError).toBeFalsy();
    }

    const resp = await client.callTool('tim_show', { what: 'errors', root: 'all' });
    const text = resp.result!.content[0].text;
    expect(text).toContain('Typed error');
    expect(text).toContain('Tagged only');
    expect(text).toContain('Both signals');
    const bothCount = (text.match(/Both signals/g) ?? []).length;
    expect(bothCount).toBe(1);
  });

  it('what:Ideas returns section children only', async () => {
    const proj = await client.callTool('tim_create_project', {
      label: 'P0420',
      content: 'Ideas Project',
    });
    const project = JSON.parse(proj.result!.content[0].text);

    const ideas = await client.callTool('tim_write', {
      content: 'Ideas',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const ideasSec = JSON.parse(ideas.result!.content[0].text);

    await client.callTool('tim_write', {
      content: 'My idea',
      parentId: ideasSec.id,
      tags: ['#idea', '#test'],
    });
    await client.callTool('tim_write', {
      content: 'Random root',
      tags: ['#idea', '#test'],
    });

    const resp = await client.callTool('tim_show', { what: 'Ideas', root: 'P0420' });
    const text = resp.result!.content[0].text;
    expect(text).toContain('My idea');
    expect(text).not.toContain('Random root');
  });

  it('output includes status legend and glyphs', async () => {
    await seedProjectWithTask(client, 'P0430', 'Glyph Test', 'In progress task', {
      status: 'in_progress',
    });

    const resp = await client.callTool('tim_show', { what: 'tasks', root: 'P0430' });
    const text = resp.result!.content[0].text;
    expect(text).toContain('[!]');
    expect(text).toMatch(/\[!\].*in_progress|#in_progress/);
    expect(text).toContain('[!]=in_progress');
  });
});
