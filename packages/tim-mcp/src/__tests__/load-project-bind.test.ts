// TIM MCP — tim_load_project bind:false replaces tim_read_project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, childServerDbPath, isolateChildServerCwd } from './helpers/child-server-workspace.js';

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');
isolateChildServerCwd();

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
      clientInfo: { name: 'load-project-bind-test', version: '0.0.1' },
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

describe('tim_load_project bind:false', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = childServerDbPath();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();

    // Seed two projects.
    await client.callTool('tim_create_project', { label: 'P8101', content: 'Project 8101', memoryOnly: true });
    await client.callTool('tim_create_project', { label: 'P8102', content: 'Project 8102', memoryOnly: true });
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('does not bind the session and can be called for multiple projects', async () => {
    const a = await client.callTool('tim_load_project', { label: 'P8101', bind: false });
    expect(a.error).toBeUndefined();
    expect(a.result!.isError).toBeFalsy();

    const b = await client.callTool('tim_load_project', { label: 'P8102', bind: false });
    expect(b.error).toBeUndefined();
    expect(b.result!.isError).toBeFalsy();

    const c = await client.callTool('tim_load_project', { label: 'P8101', bind: false });
    expect(c.error).toBeUndefined();
    expect(c.result!.isError).toBeFalsy();
  });

  it('bind:false preserves marker bytes and mtime', async () => {
    const markerPath = path.join(childServerCwd(), '.tim-project');
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 2,
      project: 'P8101',
      session: 'bind-false-session',
      exchanges: 7,
      batch_size: 5,
      batches_summarized: 1,
    }, null, 2));
    const beforeBytes = fs.readFileSync(markerPath);
    const beforeMtime = fs.statSync(markerPath, { bigint: true }).mtimeNs;

    const response = await client.callTool('tim_load_project', {
      label: 'P8102',
      bind: false,
      sessionId: 'bind-false-session',
    });

    expect(response.result?.isError).toBeFalsy();
    expect(fs.readFileSync(markerPath)).toEqual(beforeBytes);
    expect(fs.statSync(markerPath, { bigint: true }).mtimeNs).toBe(beforeMtime);
  });

  it('tim_read_project preserves marker bytes and mtime', async () => {
    const markerPath = path.join(childServerCwd(), '.tim-project');
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 2,
      project: 'P8101',
      session: 'read-project-session',
      exchanges: 4,
      batch_size: 5,
      batches_summarized: 0,
    }, null, 2));
    const beforeBytes = fs.readFileSync(markerPath);
    const beforeMtime = fs.statSync(markerPath, { bigint: true }).mtimeNs;

    const response = await client.callTool('tim_read_project', { label: 'P8102' });

    expect(response.result?.isError).toBeFalsy();
    expect(fs.readFileSync(markerPath)).toEqual(beforeBytes);
    expect(fs.statSync(markerPath, { bigint: true }).mtimeNs).toBe(beforeMtime);
  });

  it('bind:false then bind:true works — read does not consume the gate', async () => {
    const sessionId = 'bind-after-read-session';
    const read = await client.callTool('tim_load_project', {
      label: 'P8101', bind: false, sessionId,
    });
    expect(read.error).toBeUndefined();
    expect(read.result!.isError).toBeFalsy();

    // Now bind for real — should succeed because the read did NOT bind.
    const bind = await client.callTool('tim_load_project', { label: 'P8102', sessionId });
    expect(bind.error).toBeUndefined();
    expect(bind.result!.isError).toBeFalsy();

    const rejected = await client.callTool('tim_load_project', { label: 'P8101', sessionId });
    expect(rejected.result!.isError).toBe(true);
    expect(rejected.result!.content[0].text).toContain('P8102');
  });

  it('bind:false creates no .tim-project when the cwd has none', async () => {
    const markerPath = path.join(childServerCwd(), '.tim-project');
    const read = await client.callTool('tim_load_project', { label: 'P8101', bind: false });
    expect(read.result!.isError).toBeFalsy();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('bind:true syncs the cwd marker to the loaded project', async () => {
    const markerPath = path.join(childServerCwd(), '.tim-project');
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 2,
      project: 'P8101',
      session: 'bind-sync-session',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    }, null, 2));
    const bind = await client.callTool('tim_load_project', {
      label: 'P8102', sessionId: 'bind-sync-session',
    });
    expect(bind.result!.isError).toBeFalsy();
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { project: string };
    expect(marker.project).toBe('P8102');
  });

  it('tim_read_project still works as a deprecated alias for bind:false', async () => {
    const sessionId = 'bind-after-deprecated-read-session';
    const resp = await client.callTool('tim_read_project', { label: 'P8101' });
    expect(resp.error).toBeUndefined();
    expect(resp.result!.isError).toBeFalsy();

    // And the gate is still free — we can bind afterward to a different project.
    const bind = await client.callTool('tim_load_project', { label: 'P8102', sessionId });
    expect(bind.error).toBeUndefined();
    expect(bind.result!.isError).toBeFalsy();

    const rejected = await client.callTool('tim_load_project', { label: 'P8101', sessionId });
    expect(rejected.result!.isError).toBe(true);
    expect(rejected.result!.content[0].text).toContain('P8102');
  });
});
