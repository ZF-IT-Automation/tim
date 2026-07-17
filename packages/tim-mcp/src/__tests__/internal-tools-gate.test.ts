// TIM MCP — Plumbing-tool gate (Plan 4, Task 4).
// ListTools hides internal/plumbing tools by default. Setting
// TIM_EXPOSE_INTERNAL_TOOLS=1 reveals them. Hidden tools remain fully callable
// via CallTool — the summarizer and hooks depend on them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
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
      clientInfo: { name: 'internal-tools-gate-tests', version: '0.0.1' },
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResp> {
    await this.init();
    return this.send('tools/call', { name, arguments: args });
  }

  async listTools(): Promise<{ name: string; description?: string }[]> {
    await this.init();
    const resp = await this.send('tools/list', {});
    if (resp.error) throw new Error(`listTools error: ${resp.error.message}`);
    const result = resp.result as { tools?: { name: string; description?: string }[] };
    return result.tools ?? [];
  }

  kill(): void {
    try { this.proc.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => {
      if (!this.proc.killed) {
        try { this.proc.kill('SIGKILL'); } catch { /* noop */ }
      }
    }, 100);
  }
}

const INTERNAL_TOOL_NAMES = [
  'tim_write_batch_summary',
  'tim_rollup_session_summary',
  'tim_show_unsummarized',
  'tim_show_all_unsummarized',
  'tim_show_untagged',
  'tim_error_log',
  'tim_session_log',
  'tim_checkpoint',
];

describe('TIM_EXPOSE_INTERNAL_TOOLS gate', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('hides plumbing tools from ListTools by default', async () => {
    const client = new McpClient(dbPath);
    try {
      const tools = await client.listTools();
      const names = tools.map(t => t.name);
      for (const internal of INTERNAL_TOOL_NAMES) {
        expect(names, `expected ${internal} to be hidden`).not.toContain(internal);
      }
      // Sanity: a non-internal tool is still visible.
      expect(names).toContain('tim_read');
      expect(names).toContain('tim_show');
    } finally {
      client.kill();
    }
  });

  it('TIM_EXPOSE_INTERNAL_TOOLS=1 reveals the plumbing tools', async () => {
    const client = new McpClient(dbPath, { TIM_EXPOSE_INTERNAL_TOOLS: '1' });
    try {
      const tools = await client.listTools();
      const names = tools.map(t => t.name);
      for (const internal of INTERNAL_TOOL_NAMES) {
        expect(names, `expected ${internal} to be revealed`).toContain(internal);
      }
      // Non-internal tools still visible.
      expect(names).toContain('tim_read');
    } finally {
      client.kill();
    }
  });

  it('hidden tools still execute via CallTool (handlers are unconditional)', async () => {
    const client = new McpClient(dbPath);
    try {
      // tim_show_all_unsummarized is internal — its handler should still work
      // even though ListTools hides it. The summarizer depends on this.
      const resp = await client.callTool('tim_show_all_unsummarized', {});
      expect(resp.error).toBeUndefined();
      expect(resp.result!.isError).toBeFalsy();
    } finally {
      client.kill();
    }
  });

  it('TIM_EXPOSE_INTERNAL_TOOLS=false (or unset) hides; non-1 values are not truthy', async () => {
    const client = new McpClient(dbPath, { TIM_EXPOSE_INTERNAL_TOOLS: 'true' });
    try {
      const tools = await client.listTools();
      const names = tools.map(t => t.name);
      // Spec is strict: only '1' reveals. 'true', 'yes', 'on' do not.
      expect(names).not.toContain('tim_write_batch_summary');
    } finally {
      client.kill();
    }
  });
});
