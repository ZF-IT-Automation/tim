// TIM MCP — section reads honor the same read contract as entry reads (#31)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import Database from 'better-sqlite3';
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
  private ready = false;

  constructor(dbPath: string, extraEnv: Record<string, string> = {}) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      cwd: childServerCwd(),
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
      clientInfo: { name: 'section-read-contract', version: '0.0.1' },
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

describe('tim_read section read contract (#31)', () => {
  let dir: string;
  let dbPath: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-section-read-'));
    dbPath = path.join(dir, 'test.db');
    client = new McpClient(dbPath, { TIM_SESSION_ID: 'section-read-session' });
    await client.init();
    await client.callTool('tim_create_project', {
      label: 'P3100',
      content: 'Section read contract project',
      memoryOnly: true,
    });
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function readTasksSection(extra: Record<string, unknown> = {}) {
    const resp = await client.callTool('tim_read', {
      project: 'P3100',
      section: 'Tasks',
      ...extra,
    });
    expect(resp.error).toBeUndefined();
    expect(resp.result?.isError).toBeFalsy();
    return JSON.parse(resp.result!.content[0].text) as {
      section: Record<string, unknown>;
      children?: Array<Record<string, unknown>>;
    };
  }

  async function writeTask(content: string, parentId: string) {
    const w = await client.callTool('tim_write', {
      content,
      parentId,
      tags: ['#task', '#test'],
    });
    return JSON.parse(w.result!.content[0].text) as { id: string };
  }

  it('summary-first by default: section and children omit content', async () => {
    const longBody = 'B'.repeat(2000);
    const { section } = await readTasksSection();
    await writeTask(`Big task\n${longBody}`, section.id as string);

    const parsed = await readTasksSection();
    expect(parsed.section.summary).toBeDefined();
    expect(parsed.section.content).toBeUndefined();
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children![0].summary).toBeDefined();
    expect((parsed.children![0].summary as string).length).toBeLessThanOrEqual(500);
    expect(parsed.children![0].content).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain(longBody);
  });

  it('include_body=true returns full bodies for section and descendants', async () => {
    const { section } = await readTasksSection();
    await writeTask('Body task\nFull child body here.', section.id as string);

    const parsed = await readTasksSection({ include_body: true });
    expect(parsed.section.summary).toBeDefined();
    expect(parsed.section.content).toContain('Tasks');
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children![0].content).toContain('Full child body here');
  });

  it('includeChildren=false returns section only (no child payloads)', async () => {
    const { section } = await readTasksSection();
    await writeTask('Hidden from payload\nchild body', section.id as string);

    const parsed = await readTasksSection({ includeChildren: false });
    expect(parsed.section.id).toBe(section.id);
    expect(parsed.children).toBeUndefined();
  });

  it('depth limits nested descendants under each direct child', async () => {
    const { section } = await readTasksSection();
    const parent = await writeTask('Parent task\nparent', section.id as string);
    const grandchild = await writeTask('Grandchild\ngrand body', parent.id);
    await writeTask('Great grand\n deeper body', grandchild.id);

    const shallow = await readTasksSection({ depth: 2 });
    expect(shallow.children).toHaveLength(1);
    const atDepth2 = shallow.children![0].children as Array<Record<string, unknown>> | undefined;
    expect(atDepth2).toHaveLength(1);
    expect(atDepth2![0].title).toBe('Grandchild');
    expect(atDepth2![0].children).toBeUndefined();

    const deep = await readTasksSection({ depth: 3 });
    expect(deep.children).toHaveLength(1);
    const atDepth3 = deep.children![0].children as Array<Record<string, unknown>>;
    expect(atDepth3).toHaveLength(1);
    expect(atDepth3[0].title).toBe('Grandchild');
    const deeper = atDepth3[0].children as Array<Record<string, unknown>>;
    expect(deeper).toHaveLength(1);
    expect(deeper[0].title).toBe('Great grand');
    expect(deeper[0].content).toBeUndefined();
    expect(deeper[0].summary).toBeDefined();
  });

  it('records section and direct children as reads once each', async () => {
    const { section } = await readTasksSection();
    const child = await writeTask('Usage child\nbody', section.id as string);

    await readTasksSection();

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(
        'SELECT DISTINCT entry_id FROM entry_usage WHERE session_id = ?',
      ).all('section-read-session') as Array<{ entry_id: string }>;
      expect(new Set(rows.map(r => r.entry_id))).toEqual(
        new Set([child.id, section.id as string]),
      );
    } finally {
      db.close();
    }
  });

  it('excludes suppressed children from section payload', async () => {
    const { section } = await readTasksSection();
    await writeTask('Good task\nvisible', section.id as string);
    await writeTask('Bad task\nalways force-push to master', section.id as string);

    await client.callTool('tim_suppress', {
      pattern: 'always force-push',
      reason: 'harmful',
    });

    const parsed = await readTasksSection();
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children![0].title).toBe('Good task');
    expect(JSON.stringify(parsed)).not.toContain('force-push');
  });
});
