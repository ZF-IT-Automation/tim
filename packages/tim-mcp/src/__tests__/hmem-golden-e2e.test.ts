import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';
import * as os from 'node:os';
import { createV2HmemDatabase } from 'tim-migrate';
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
  private stderr = '';
  private ready = false;
  private exited = false;
  private exitError: Error | null = null;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(dbPath: string) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      cwd: childServerCwd(),
      env: { ...process.env, TIM_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', chunk => this.onData(chunk.toString('utf8')));
    this.proc.stderr!.on('data', chunk => this.onStderr(chunk.toString('utf8')));
    this.exitPromise = new Promise(resolve => {
      this.resolveExit = resolve;
    });
    this.proc.on('error', err => this.failPending(new Error(this.formatFailure(`TIM MCP child error: ${err.message}`))));
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      const detail = code === 0
        ? `exited cleanly${signal ? ` via ${signal}` : ''}`
        : `exited with code ${code ?? 'unknown'}${signal ? ` via ${signal}` : ''}`;
      this.failPending(new Error(this.formatFailure(`TIM MCP child ${detail}`)));
      this.resolveExit();
    });
  }

  private failPending(err: Error): void {
    this.exitError = err;
    for (const [, reject] of this.pending) reject(err);
    this.pending.clear();
  }

  private onStderr(text: string): void {
    this.stderr = `${this.stderr}${text}`.slice(-4000);
  }

  private formatFailure(message: string): string {
    const stderr = this.stderr.trim();
    return stderr ? `${message}\nRecent stderr:\n${stderr}` : message;
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
        // ignore non-json
      }
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcResp> {
    if (this.exited) {
      return Promise.reject(this.exitError ?? new Error(this.formatFailure(`Cannot send ${method}: MCP child already exited`)));
    }
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.formatFailure(`Timeout waiting for response to ${method}`)));
      }, 10000);
      this.pending.set(id, resp => {
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
      clientInfo: { name: 'hmem-golden-e2e-test', version: '0.0.1' },
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResp> {
    await this.init();
    return this.send('tools/call', { name, arguments: args });
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.proc.kill('SIGTERM');
    await Promise.race([
      this.exitPromise,
      new Promise(resolve => setTimeout(resolve, 250)),
    ]);
    if (!this.exited) {
      this.proc.kill('SIGKILL');
    }
    await Promise.race([
      this.exitPromise,
      new Promise(resolve => setTimeout(resolve, 500)),
    ]);
  }
}

function parsePayload(resp: JsonRpcResp): any {
  expect(resp.error).toBeUndefined();
  expect(resp.result?.isError).toBeFalsy();
  return JSON.parse(resp.result!.content[0].text);
}

function createHmemFixture(filePath: string): void {
  const db = createV2HmemDatabase(filePath);
  db.prepare(`
    INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
      access_count, obsolete, favorite, irrelevant, pinned, tags)
    VALUES ('uid-project-1', 'P0100', 'P', 100, 'Imported Golden Project',
      '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0, 0, 0, 0, 0, '["#project"]')
  `).run();
  db.prepare(`
    INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant)
    VALUES ('uid-section-tasks', 'uid-project-1', NULL, 2, 1, 'Tasks',
      '[]', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
  `).run();
  db.prepare(`
    INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant)
    VALUES ('uid-task-1', 'uid-project-1', 'uid-section-tasks', 3, 1, 'Implement hmem import audit',
      '["#task"]', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
  `).run();
  db.prepare(`
    INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant)
    VALUES ('uid-section-notes', 'uid-project-1', NULL, 2, 2, 'Notes',
      '[]', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
  `).run();
  db.prepare(`
    INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant)
    VALUES ('uid-note-1', 'uid-project-1', 'uid-section-notes', 3, 1, 'Track the repair flow',
      '["#note"]', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
  `).run();
  db.prepare(`
    INSERT INTO links (src_uid, dst_uid, kind)
    VALUES ('uid-task-1', 'uid-note-1', 'relates')
  `).run();
  db.close();
}

describe('hmem golden E2E', () => {
  let dir: string;
  let dbPath: string;
  let hmemPath: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-hmem-golden-'));
    dbPath = path.join(dir, 'tim.db');
    hmemPath = path.join(dir, 'source.hmem');
    createHmemFixture(hmemPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(async () => {
    await client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('migrates, audits, repairs, and loads a hmem project', async () => {
    const manifest = parsePayload(await client.callTool('tim_import_manifest', { source: hmemPath }));
    expect(manifest.labels.map((l: any) => l.label)).toContain('P0100');

    const dry = parsePayload(await client.callTool('tim_import', {
      source: hmemPath,
      dryRun: true,
      deduplicate: true,
    }));
    expect(dry.dryRun).toBe(true);
    expect(dry.newCount).toBeGreaterThan(0);

    const imported = parsePayload(await client.callTool('tim_import', {
      source: hmemPath,
      deduplicate: true,
    }));
    expect(imported.entriesImported).toBeGreaterThan(0);

    const audit = parsePayload(await client.callTool('tim_import_audit', { source: hmemPath }));
    expect(audit.projects[0].label).toBe('P0100');

    const repair = parsePayload(await client.callTool('tim_repair_section', {
      project: 'P0100',
      title: 'Tasks',
    }));
    expect(repair.section.id).toBeTruthy();

    const loaded = (await client.callTool('tim_load_project', {
      label: 'P0100',
      bind: false,
      depth: 3,
    })).result!.content[0].text;
    expect(loaded).toContain('Tasks');
    expect(loaded).toContain('Notes');
    expect(loaded).toContain('Implement hmem import audit');
    expect(loaded).toContain('Track the repair flow');
  });
});
