// TIM MCP — explicit project creation mode contract through stdio JSON-RPC.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { readMarker } from 'tim-hooks';

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');
const CLI_PATH = path.resolve(__dirname, '..', '..', '..', 'tim-cli', 'dist', 'cli.js');

interface JsonRpcResponse {
  id: number;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

interface ToolListing {
  name: string;
  description?: string;
  inputSchema: {
    properties?: Record<string, { description?: string }>;
  };
}

class StdioMcpClient {
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();
  private nextId = 1;
  private buffer = '';
  private initialized = false;

  constructor(dbPath: string, cwd: string, extraEnv: Record<string, string> = {}) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      cwd,
      env: { ...process.env, ...extraEnv, TIM_DB_PATH: dbPath },
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

  async doctor(): Promise<JsonRpcResponse> {
    await this.init();
    return this.send('tools/call', { name: 'tim_doctor', arguments: {} });
  }

  async listTools(): Promise<ToolListing[]> {
    await this.init();
    const response = await this.send('tools/list', {});
    return (response.result as unknown as { tools: ToolListing[] }).tools;
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
    const dbDir = path.join(root, "database dir's");
    fs.mkdirSync(dbDir);
    dbPath = path.join(dbDir, 'custom tim.db');
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

  it('publishes the exact explicit-mode schema guidance', async () => {
    const tool = (await client.listTools()).find(candidate => candidate.name === 'tim_create_project');

    expect(tool?.description).toBe(
      'Create a project in exactly one mode. Every project representing files on disk MUST pass its absolute path; memoryOnly:true is only for an intentionally virtual/database-only project and is never a shortcut for an unknown cwd.',
    );
    expect(tool?.inputSchema.properties?.path?.description).toBe(
      'Absolute directory for every project representing files on disk',
    );
    expect(tool?.inputSchema.properties?.memoryOnly?.description).toBe(
      'Must be true, and only for an intentional database-only project; mutually exclusive with path',
    );
    expect(tool?.inputSchema.properties?.aliases?.description).toBeUndefined();
  });

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

  it('returns a shell-safe same-DB recovery command after MCP marker publication fails', async () => {
    client.close();
    const preload = path.join(root, 'fail-marker-write.cjs');
    fs.writeFileSync(preload, `
const fs = require('node:fs');
const original = fs.writeFileSync;
fs.writeFileSync = function(file, ...args) {
  if (String(file).includes('.tim-project.tmp.')) throw new Error('simulated marker failure');
  return original.call(this, file, ...args);
};
`);
    client = new StdioMcpClient(dbPath, serverCwd, {
      NODE_OPTIONS: `--require=${preload}`,
    });
    const target = path.join(root, 'partial-target');
    fs.mkdirSync(target);

    const result = resultOf(await client.createProject({
      label: 'P1203',
      content: 'Partial project',
      path: target,
    }));

    expect(result.isError).toBe(true);
    const canonicalDb = fs.realpathSync(dbPath);
    expect(result.content[0].text).toContain(
      `TIM_DB_PATH='${canonicalDb.replaceAll("'", "'\"'\"'")}' tim bind-project`,
    );
    expect(result.content[0].text).toContain("--label 'P1203'");
    expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(false);
    const store = new TimStore(dbPath);
    expect(await store.loadProject('P1203')).not.toBeNull();
    store.close();
  });

  it('reports the canonical opened DB and supports the quoted CLI flow from another cwd', async () => {
    client.close();
    const relativeDb = path.join("relative database dir's", 'custom tim.db');
    fs.mkdirSync(path.join(serverCwd, path.dirname(relativeDb)), { recursive: true });
    client = new StdioMcpClient(relativeDb, serverCwd);

    const doctor = resultOf(await client.doctor());
    expect(doctor.isError).toBeFalsy();
    const canonicalDb = fs.realpathSync(path.join(serverCwd, relativeDb));
    expect(doctor.content[0].text).toContain(`TIM Doctor — ${canonicalDb}`);
    expect(doctor.content[0].text).not.toContain(`TIM Doctor — ${relativeDb}\n`);

    const shellCwd = path.join(root, 'invoking-shell');
    const target = path.join(root, 'created-from-doctor');
    fs.mkdirSync(shellCwd);
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const command = [
      `TIM_DB_PATH=${quote(canonicalDb)}`,
      quote(process.execPath),
      quote(CLI_PATH),
      'new-project',
      '--path', quote(target),
      '--name', quote('Doctor path project'),
      '--no-git',
    ].join(' ');
    const created = spawnSync('/bin/sh', ['-c', command], {
      cwd: shellCwd,
      encoding: 'utf8',
      env: process.env,
    });
    expect(created.status).toBe(0, created.stderr);
    expect(readMarker(target)?.project).toBe('P0001');
    const store = new TimStore(canonicalDb);
    expect(await store.loadProject('P0001')).not.toBeNull();
    store.close();
  });

  it('reports the active transient store identity accurately', async () => {
    client.close();
    client = new StdioMcpClient(':memory:', serverCwd);

    const doctor = resultOf(await client.doctor());

    expect(doctor.isError).toBeFalsy();
    expect(doctor.content[0].text).toContain('TIM Doctor — :memory:');
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
