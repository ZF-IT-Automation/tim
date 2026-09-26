// TIM MCP — core tool listing.
// ListTools returns the core set by default. TIM_MCP_TOOLS=all (or config
// mcp.tools "all") lists every registered tool. Hidden tools remain callable
// via CallTool — the summarizer and hooks depend on that.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TOOL_DEFS } from '../server.js';
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

const CORE_TOOLS = [
  'tim_load_project',
  'tim_read',
  'tim_search',
  'tim_write',
  'tim_update',
  'tim_show',
  'tim_preview_briefing',
  'tim_resume_topic',
  'tim_delete',
  'tim_doctor',
  'tim_move_entry',
];

function sorted(names: string[]): string[] {
  return names.slice().sort();
}

describe('core MCP tool listing', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('lists exactly the core set by default', async () => {
    const client = new McpClient(dbPath);
    try {
      const names = (await client.listTools()).map(t => t.name);
      expect(sorted(names)).toEqual(sorted(CORE_TOOLS));
      expect(names).not.toContain('tim_checkpoint');
      expect(names).not.toContain('tim_health');
      expect(names).not.toContain('tim_write_batch_summary');
    } finally {
      client.kill();
    }
  });

  it('passes an agent handoff note through tim_checkpoint', async () => {
    const client = new McpClient(dbPath);
    try {
      await client.callTool('tim_session_start', { sessionId: 'agent-handoff' });
      const resp = await client.callTool('tim_checkpoint', {
        sessionId: 'agent-handoff',
        handoff_note: 'done: task D | next: task 5',
      });
      expect(resp.error).toBeUndefined();
      expect(resp.result?.isError).toBeFalsy();
      const resume = await client.callTool('tim_session_resume', { sessionId: 'agent-handoff' });
      expect(resume.result?.content[0]?.text).toContain('done: task D | next: task 5');
    } finally {
      client.kill();
    }
  });

  it('TIM_MCP_TOOLS=all lists every registered tool', async () => {
    const client = new McpClient(dbPath, { TIM_MCP_TOOLS: 'all' });
    try {
      const names = (await client.listTools()).map(t => t.name);
      expect(names).toEqual(TOOL_DEFS.map(def => def.name));
      expect(names).toContain('tim_health');
      expect(names).toContain('tim_write_batch_summary');
    } finally {
      client.kill();
    }
  });

  it('mcp.tools all in config lists every tool, and TIM_MCP_TOOLS=core overrides it', async () => {
    const configPath = path.join(process.env.HOME!, '.tim', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { tools: 'all' } }));
    const fromConfig = new McpClient(dbPath);
    // Separate test DBs keep the concurrent stdio servers from contending on
    // SQLite startup; tool-list mode is independent of database contents.
    const overridden = new McpClient(`${dbPath}.override`, { TIM_MCP_TOOLS: 'core' });
    try {
      const fromConfigNames = (await fromConfig.listTools()).map(t => t.name);
      expect(fromConfigNames).toEqual(TOOL_DEFS.map(def => def.name));
      const overriddenNames = (await overridden.listTools()).map(t => t.name);
      expect(sorted(overriddenNames)).toEqual(sorted(CORE_TOOLS));
    } finally {
      fromConfig.kill();
      overridden.kill();
      fs.rmSync(configPath, { force: true });
      fs.rmSync(`${dbPath}.override`, { force: true });
    }
  });

  it('hidden tools still execute via CallTool', async () => {
    const client = new McpClient(dbPath);
    try {
      const health = await client.callTool('tim_health', {});
      expect(health.error).toBeUndefined();
      expect(health.result?.isError).toBeFalsy();
      expect(health.result?.content[0]?.text).not.toContain('Unknown tool');

      const batch = await client.callTool('tim_write_batch_summary', {
        sessionId: 'not-a-session',
        batchIndex: 1,
        summary: 'still dispatched',
        seqFrom: 0,
        seqTo: 0,
      });
      expect(batch.error).toBeUndefined();
      expect(batch.result?.content[0]?.text ?? '').not.toContain('Unknown tool');

      const sweep = await client.callTool('tim_show_all_unsummarized', {});
      expect(sweep.error).toBeUndefined();
      expect(sweep.result?.isError).toBeFalsy();
    } finally {
      client.kill();
    }
  });

  it('TIM_EXPOSE_INTERNAL_TOOLS does not widen the default list', async () => {
    const client = new McpClient(dbPath, { TIM_EXPOSE_INTERNAL_TOOLS: '1' });
    try {
      const names = (await client.listTools()).map(t => t.name);
      expect(sorted(names)).toEqual(sorted(CORE_TOOLS));
      expect(names).not.toContain('tim_write_batch_summary');
    } finally {
      client.kill();
    }
  });
});
