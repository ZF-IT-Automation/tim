import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { TimStore } from 'tim-store';

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

  constructor(dbPath: string, cwd: string) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      cwd,
      env: { ...process.env, TIM_DB_PATH: dbPath, TIM_PROVENANCE: '0', TIM_DEDUP_CHECK: '0' },
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
        // ignore non-JSON
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
      }, 15000);
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
      clientInfo: { name: 'vcs-wiring', version: '0.0.1' },
    });
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
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

describe('MCP wires projectPath for coding-task vcs detection', () => {
  let client: McpClient;
  let dbPath: string;
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-vcs-mcp-'));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    // Local marker so walk-up does not pick an ancestor .tim-project (e.g. /tmp).
    fs.writeFileSync(
      path.join(repoDir, '.tim-project'),
      JSON.stringify({
        version: 2,
        project: 'P9998',
        session: 'vcs-wiring',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      }),
      'utf8',
    );
    dbPath = path.join(repoDir, `tim-${Date.now()}.db`);
    client = new McpClient(dbPath, repoDir);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('tim_write sets task.vcs=git for coding tasks when server cwd is a git repo', async () => {
    const writeResp = await client.callTool('tim_write', {
      content: 'Implement the feature',
      tags: ['#task', '#coding'],
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
    });
    expect(writeResp.result?.isError).not.toBe(true);
    const written = JSON.parse(writeResp.result!.content[0].text);
    const task = written.metadata?.task ?? written.entry?.metadata?.task;
    expect(task?.vcs).toBe('git');
  });

  it('tim_update sets task.vcs=git on first coding update when server cwd is a git repo', async () => {
    // Seed without projectPath so vcs stays unset until MCP update wires it.
    const store = new TimStore(dbPath);
    const seeded = await store.write('Coding task without vcs yet', {
      tags: ['#task', '#coding'],
      metadata: { type: 'task', task: { status: 'todo', subtype: 'coding' } },
    });
    expect((seeded.metadata.task as { vcs?: string }).vcs).toBeUndefined();
    store.close();

    const updateResp = await client.callTool('tim_update', {
      id: seeded.id,
      metadata: { task: { status: 'in_progress' } },
    });
    expect(updateResp.result?.isError).not.toBe(true);
    const updated = JSON.parse(updateResp.result!.content[0].text);
    const task = updated.metadata?.task ?? updated.entry?.metadata?.task;
    expect(task?.vcs).toBe('git');
  });
});
