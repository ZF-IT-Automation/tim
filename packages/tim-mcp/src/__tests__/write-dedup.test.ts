// TIM MCP — tim_write dedup gate integration tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';
import os from 'node:os';
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

describe('tim_write dedup gate', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-dedup-'));
    client = new McpClient(path.join(dir, 'test.db'));
    await client.init();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a near-duplicate title and lists candidates', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P9000', content: 'Dedup Proj' });
    const project = JSON.parse(proj.result!.content![0].text);
    const section = await client.callTool('tim_write', {
      content: 'Notes',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const sec = JSON.parse(section.result!.content![0].text);

    const first = await client.callTool('tim_write', {
      content: 'Reminder System via Cron Checker\nDesign notes.',
      parentId: sec.id,
      tags: ['#reminder', '#design'],
    });
    expect(first.result?.isError).toBeFalsy();

    const dup = await client.callTool('tim_write', {
      content: 'Reminder System Cron Checker\nSlightly different notes.',
      parentId: sec.id,
      tags: ['#reminder', '#design'],
    });
    expect(dup.result?.isError).toBe(true);
    const body = JSON.parse(dup.result!.content![0].text);
    expect(body.status).toBe('duplicate_suspected');
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates[0].title).toBe('Reminder System via Cron Checker');
  });

  it('force:true bypasses the gate', async () => {
    await client.callTool('tim_write', {
      content: 'Unique fact one\nBody.', tags: ['#a', '#b'],
    });
    const forced = await client.callTool('tim_write', {
      content: 'Unique fact one\nSecond body.', tags: ['#a', '#b'], force: true,
    });
    expect(forced.result?.isError).toBeFalsy();
  });

  it('never blocks schema-kind writes', async () => {
    const s1 = await client.callTool('tim_write', {
      content: 'Session summary batch', metadata: { kind: 'batch-summary' },
    });
    const s2 = await client.callTool('tim_write', {
      content: 'Session summary batch', metadata: { kind: 'batch-summary' },
    });
    expect(s1.result?.isError).toBeFalsy();
    expect(s2.result?.isError).toBeFalsy();
  });

  it('skips dedup gate without parentId even when another project has the same title', async () => {
    const projA = await client.callTool('tim_create_project', { label: 'P9001', content: 'Project A' });
    const projectA = JSON.parse(projA.result!.content![0].text);
    const sectionA = await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: projectA.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const secA = JSON.parse(sectionA.result!.content![0].text);

    await client.callTool('tim_write', {
      title: 'Common Setup',
      content: 'Common Setup\nNotes in project A.',
      parentId: secA.id,
      tags: ['#note', '#test'],
    });

    const projB = await client.callTool('tim_create_project', { label: 'P9002', content: 'Project B' });
    expect(projB.result?.isError).toBeFalsy();

    const second = await client.callTool('tim_write', {
      title: 'Common Setup',
      content: 'Common Setup\nNotes in project B without parent.',
      tags: ['#note', '#test'],
    });
    expect(second.result?.isError).toBeFalsy();
    const body = JSON.parse(second.result!.content![0].text);
    expect(body.title).toBe('Common Setup');
  });

  it('applies dedup gate within project when parentId is set', async () => {
    const proj = await client.callTool('tim_create_project', { label: 'P9003', content: 'Scoped Project' });
    const project = JSON.parse(proj.result!.content![0].text);
    const section = await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    const sec = JSON.parse(section.result!.content![0].text);

    const first = await client.callTool('tim_write', {
      title: 'Shared Task Title',
      content: 'Shared Task Title\nFirst body.',
      parentId: sec.id,
      tags: ['#task', '#test'],
    });
    expect(first.result?.isError).toBeFalsy();

    const dup = await client.callTool('tim_write', {
      title: 'Shared Task Title',
      content: 'Shared Task Title\nSecond body.',
      parentId: sec.id,
      tags: ['#task', '#test'],
    });
    expect(dup.result?.isError).toBe(true);
    const body = JSON.parse(dup.result!.content![0].text);
    expect(body.status).toBe('duplicate_suspected');
  });
});
