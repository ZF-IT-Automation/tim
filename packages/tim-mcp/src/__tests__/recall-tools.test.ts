// TIM MCP — tim_guard + tim_delta integration tests

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
      clientInfo: { name: 'recall-test', version: '0.0.1' },
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

describe('tim_guard', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-recall-'));
    client = new McpClient(path.join(dir, 'test.db'));
    await client.init();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('warns when a planned action matches a known failure', async () => {
    await client.callTool('tim_write', {
      content: 'rmapi upload fails with HTTP 400\nUse the sync fox v3 API instead.',
      tags: ['#remarkable', '#upload'],
      metadata: { kind: 'error' },
    });

    const res = await client.callTool('tim_guard', {
      action: 'upload the PDF to remarkable via rmapi',
    });
    const body = JSON.parse(res.result!.content[0].text);
    expect(body.status).toBe('warnings');
    expect(body.matches.length).toBe(1);
    expect(body.matches[0].title).toContain('rmapi upload fails');
  });

  it('reports clear when nothing matches', async () => {
    const res = await client.callTool('tim_guard', { action: 'water the office plants' });
    const body = JSON.parse(res.result!.content[0].text);
    expect(body.status).toBe('clear');
  });
});

describe('tim_delta', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-delta-'));
    client = new McpClient(path.join(dir, 'test.db'));
    await client.init();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports changes in a project since an explicit cutoff', async () => {
    const projRes = await client.callTool('tim_create_project', {
      label: 'P0001',
      content: 'Delta Test',
    });
    const project = JSON.parse(projRes.result!.content[0].text);
    const cutoff = new Date(Date.now() - 1000).toISOString();
    await client.callTool('tim_write', {
      content: 'Fresh entry\nBody.',
      parentId: project.id,
      tags: ['#a', '#b'],
    });

    const res = await client.callTool('tim_delta', { project: 'P0001', since: cutoff });
    expect(res.result?.isError).toBeFalsy();
    const body = JSON.parse(res.result!.content[0].text);
    expect(body.since).toBe(cutoff);
    expect(body.created.some((e: { title: string }) => e.title === 'Fresh entry')).toBe(true);
  });

  it('errors usefully when no project is given or bound', async () => {
    const res = await client.callTool('tim_delta', {});
    expect(res.result?.isError).toBe(true);
  });
});
