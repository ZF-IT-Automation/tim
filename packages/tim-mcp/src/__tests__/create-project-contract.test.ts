// TIM MCP — explicit project creation mode contract through stdio JSON-RPC.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { readMarker } from 'tim-hooks';

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

interface JsonRpcResponse {
  id: number;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

class StdioMcpClient {
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();
  private nextId = 1;
  private buffer = '';
  private initialized = false;

  constructor(dbPath: string, cwd: string) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      cwd,
      env: { ...process.env, TIM_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', chunk => this.onData(chunk.toString('utf8')));
    this.proc.stderr!.on('data', () => {});
  }

  private onData(text: string): void {
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const resolve = this.pending.get(response.id);
        if (resolve) {
          this.pending.delete(response.id);
          resolve(response);
        }
      } catch {
        // Ignore non-protocol output.
      }
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 10_000);
      this.pending.set(id, response => {
        clearTimeout(timer);
        resolve(response);
      });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'create-project-contract-test', version: '0.0.1' },
    });
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    this.initialized = true;
  }

  async createProject(args: Record<string, unknown>): Promise<JsonRpcResponse> {
    await this.init();
    return this.send('tools/call', { name: 'tim_create_project', arguments: args });
  }

  close(): void {
    this.proc.kill('SIGTERM');
  }
}

function resultOf(response: JsonRpcResponse): NonNullable<JsonRpcResponse['result']> {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  return response.result!;
}

function payloadOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = resultOf(response);
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('tim_create_project explicit mode contract', () => {
  let root: string;
  let serverCwd: string;
  let dbPath: string;
  let client: StdioMcpClient;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-create-contract-'));
    serverCwd = path.join(root, 'server-cwd');
    fs.mkdirSync(serverCwd);
    dbPath = path.join(root, 'tim.db');
    client = new StdioMcpClient(dbPath, serverCwd);
    await client.init();
  });

  afterEach(() => {
    client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function expectNoProject(label: string): Promise<void> {
    const store = new TimStore(dbPath);
    try {
      expect(await store.resolveProjectLabel(label)).toMatchObject({ status: 'not_found' });
    } finally {
      store.close();
    }
  }

  it('rejects a label-only call with actionable mode guidance and creates no project', async () => {
    const response = await client.createProject({ label: 'P1200' });
    const result = resultOf(response);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/absolute project path/i);
    expect(result.content[0].text).toMatch(/memoryOnly:\s*true/i);
    await expectNoProject('P1200');
  });

  it('creates an intentional memory-only entry without a server-cwd marker', async () => {
    const payload = payloadOf(await client.createProject({
      label: 'P1201',
      content: 'Virtual project',
      metadata: { name: 'Virtual' },
      aliases: ['virtual-alias'],
      memoryOnly: true,
    }));

    expect(payload).toMatchObject({
      mode: 'memory-only',
      metadata: { label: 'P1201', name: 'Virtual' },
    });
    expect(payload).toHaveProperty('id');
    expect(fs.existsSync(path.join(serverCwd, '.tim-project'))).toBe(false);
  });

  it('binds the exact canonical target and returns verified path metadata', async () => {
    const target = path.join(root, 'target');
    const targetLink = path.join(root, 'target-link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, targetLink);
    const canonical = fs.realpathSync(target);

    const payload = payloadOf(await client.createProject({
      label: 'P1202',
      content: 'Bound project',
      metadata: { name: 'Bound', path: '/caller-value-must-not-win' },
      path: targetLink,
    }));

    expect(payload).toMatchObject({
      mode: 'bound',
      projectPath: canonical,
      markerPath: path.join(canonical, '.tim-project'),
      metadata: { label: 'P1202', name: 'Bound', path: canonical },
    });
    expect(readMarker(canonical)?.project).toBe('P1202');
    expect(fs.existsSync(path.join(serverCwd, '.tim-project'))).toBe(false);
  });

  it.each([
    ['both path and memory-only modes', 'P1210', { path: '__TARGET__', memoryOnly: true }],
    ['memoryOnly:false without a path', 'P1211', { memoryOnly: false }],
    ['memory-only mode with metadata.path', 'P1212', { memoryOnly: true, metadata: { path: '/embedded' } }],
  ])('rejects %s without creating a project', async (_name, label, modeArgs) => {
    const target = path.join(root, `target-${label}`);
    fs.mkdirSync(target);
    const args = Object.fromEntries(
      Object.entries(modeArgs).map(([key, value]) => [key, value === '__TARGET__' ? target : value]),
    );

    const result = resultOf(await client.createProject({ label, ...args }));

    expect(result.isError).toBe(true);
    await expectNoProject(label);
  });
});
