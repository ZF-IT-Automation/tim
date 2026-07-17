import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_SERVER_PATH = path.resolve(__dirname, '..', '..', '..', 'dist', 'server.js');

export interface JsonRpcResp {
  id: number;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

export interface McpClientOptions {
  dbPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
  serverPath?: string;
}

/**
 * Shared stdio MCP client for integration tests.
 * Spawns `dist/server.js` with TIM_DB_PATH (and optional cwd/env).
 */
export class McpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (resp: JsonRpcResp) => void>();
  private buffer = '';
  private ready = false;
  private readonly timeoutMs: number;
  private readonly clientInfo: { name: string; version: string };

  constructor(options: McpClientOptions) {
    const serverPath = options.serverPath ?? DEFAULT_SERVER_PATH;
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Server dist not found: ${serverPath}. Run "npm run build" first.`);
    }
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.clientInfo = options.clientInfo ?? { name: 'tim-mcp-test', version: '0.0.1' };
    this.proc = spawn('node', [serverPath], {
      cwd: options.cwd,
      env: {
        ...process.env,
        TIM_DB_PATH: options.dbPath,
        ...options.env,
      },
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
      }, this.timeoutMs);
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
      clientInfo: this.clientInfo,
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
