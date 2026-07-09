import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createV2HmemDatabase } from 'tim-migrate';

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
    this.proc.stdout!.on('data', chunk => this.onData(chunk.toString('utf8')));
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
        // ignore non-json
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
      clientInfo: { name: 'import-audit-test', version: '0.0.1' },
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
    VALUES ('uid-project-1', 'P0100', 'P', 100, 'Imported Project',
      '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0, 0, 0, 0, 0, '["#project"]')
  `).run();
  db.prepare(`
    INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant)
    VALUES ('uid-node-1', 'uid-project-1', NULL, 2, 1, 'Imported loose child',
      '[]', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
  `).run();
  db.close();
}

describe('hmem import audit MCP tools', () => {
  let dir: string;
  let dbPath: string;
  let hmemPath: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-import-audit-'));
    dbPath = path.join(dir, 'tim.db');
    hmemPath = path.join(dir, 'source.hmem');
    createHmemFixture(hmemPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tim_import_manifest reports labels before writing to TIM', async () => {
    const manifest = parsePayload(await client.callTool('tim_import_manifest', { source: hmemPath }));
    expect(manifest.format).toBe('v2');
    expect(manifest.entryCount).toBe(1);
    expect(manifest.labels).toContainEqual({
      label: 'P0100',
      prefix: 'P',
      seq: 100,
      title: 'Imported Project',
      nodeCount: 1,
    });
  });

  it('tim_import_audit flags missing project sections after import', async () => {
    parsePayload(await client.callTool('tim_import', { source: hmemPath, deduplicate: true }));

    const audit = parsePayload(await client.callTool('tim_import_audit', {
      source: hmemPath,
      includeRepairPlan: true,
    }));
    expect(audit.projects[0].label).toBe('P0100');
    expect(audit.projects[0].missingSections).toContain('Tasks');
    expect(audit.findings.some((f: string) => f.includes('P0100'))).toBe(true);
    expect(audit.suggestedTools).toContain('tim_repair_section');
    expect(audit.repairPlan.actions.some((a: any) => a.tool === 'tim_repair_section')).toBe(true);
    expect(audit.repairPlan.applyAutomatically).toBe(false);
  });

  it('tim_import_audit omits repairPlan by default', async () => {
    parsePayload(await client.callTool('tim_import', { source: hmemPath, deduplicate: true }));

    const audit = parsePayload(await client.callTool('tim_import_audit', { source: hmemPath }));
    expect(audit.repairPlan).toBeUndefined();
  });

  it('tim_repair_section creates sections and can move children safely', async () => {
    const project = parsePayload(await client.callTool('tim_create_project', { label: 'P0200', content: 'Manual Project' }));
    const loose = parsePayload(await client.callTool('tim_write', {
      parentId: project.id,
      content: 'Loose child',
      force: true,
    }));
    const dry = parsePayload(await client.callTool('tim_repair_section', {
      project: 'P0200',
      title: 'Tasks',
      moveChildrenFromIds: [loose.id],
      dryRun: true,
    }));
    expect(dry.dryRun).toBe(true);
    expect(dry.created).toBe(false);
    expect(dry.moves).toHaveLength(1);

    const repaired = parsePayload(await client.callTool('tim_repair_section', {
      project: 'P0200',
      title: 'Tasks',
      moveChildrenFromIds: [loose.id],
    }));
    expect(repaired.created).toBe(true);
    expect(repaired.moves[0].moved).toBe(true);

    const structure = parsePayload(await client.callTool('tim_project_structure', { label: 'P0200' }));
    const tasks = structure.sections.find((s: any) => s.title === 'Tasks');
    expect(tasks.childCount).toBe(1);
  });

  it('tim_dry_run_move reports move impact without writing', async () => {
    parsePayload(await client.callTool('tim_create_project', { label: 'P0300', content: 'Move Project' }));
    const section = parsePayload(await client.callTool('tim_repair_section', {
      project: 'P0300',
      title: 'Tasks',
    }));
    const entry = parsePayload(await client.callTool('tim_write', {
      content: 'Move me',
      force: true,
    }));

    const plan = parsePayload(await client.callTool('tim_dry_run_move', {
      id: entry.id,
      newParentId: section.section.id,
    }));
    expect(plan.wouldMove).toBe(true);
    expect(plan.current.parentId).toBeNull();
    expect(plan.next.parentId).toBe(section.section.id);

    const readBack = parsePayload(await client.callTool('tim_read', { id: entry.id }));
    expect(readBack.entry.parentId).toBeNull();
  });
});
