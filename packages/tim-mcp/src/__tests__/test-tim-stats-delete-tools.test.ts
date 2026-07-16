// TIM MCP — tim_stats, tim_delete_batch, tim_section_children (TDD)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';
import { TimStore } from 'tim-store';
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
        // ignore non-JSON lines
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
      clientInfo: { name: 'stats-delete-test', version: '0.0.1' },
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

function parseResult(resp: JsonRpcResp): unknown {
  expect(resp.error).toBeUndefined();
  expect(resp.result?.isError).toBeFalsy();
  return JSON.parse(resp.result!.content[0].text);
}

describe('tim_stats — content statistics', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-stats-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('empty DB → zeros and empty arrays', async () => {
    const stats = parseResult(await client.callTool('tim_stats')) as Record<string, unknown>;
    expect(stats.totalEntries).toBe(0);
    expect(stats.totalContentBytes).toBe(0);
    expect(stats.avgContentChars).toBe(0);
    expect(stats.maxContentChars).toBe(0);
    expect(stats.minContentChars).toBe(0);
    expect(stats.buckets).toEqual([]);
    expect(stats.byKind).toEqual([]);
  });

  it('single entry → correct bytes and kind', async () => {
    await client.callTool('tim_write', {
      content: 'Note\n\nhello world',
      metadata: { kind: 'note' },
    });
    const stats = parseResult(await client.callTool('tim_stats')) as {
      totalEntries: number;
      totalContentBytes: number;
      avgContentChars: number;
      byKind: { kind: string; count: number; totalBytes: number }[];
    };
    expect(stats.totalEntries).toBe(1);
    expect(stats.totalContentBytes).toBe(11);
    expect(stats.avgContentChars).toBe(11);
    expect(stats.byKind).toEqual([{ kind: 'note', count: 1, totalBytes: 11 }]);
  });

  it('mixed kinds → byKind groups', async () => {
    await client.callTool('tim_write', {
      content: 'Task one\n\naaa',
      metadata: { kind: 'task' },
    });
    await client.callTool('tim_write', {
      content: 'Task two\n\nbbbb',
      metadata: { kind: 'task' },
    });
    await client.callTool('tim_write', {
      content: 'Idea\n\nccccc',
      metadata: { kind: 'idea' },
    });
    const stats = parseResult(await client.callTool('tim_stats')) as {
      byKind: { kind: string; count: number; totalBytes: number }[];
    };
    const byKind = Object.fromEntries(stats.byKind.map(k => [k.kind, k]));
    expect(byKind.task.count).toBe(2);
    expect(byKind.task.totalBytes).toBe(7);
    expect(byKind.idea.count).toBe(1);
    expect(byKind.idea.totalBytes).toBe(5);
  });

  it('custom buckets → correct cumulative thresholds', async () => {
    await client.callTool('tim_write', { content: `E1\n\n${'x'.repeat(50)}` });
    await client.callTool('tim_write', { content: `E2\n\n${'y'.repeat(200)}` });
    await client.callTool('tim_write', { content: `E3\n\n${'z'.repeat(600)}` });

    const stats = parseResult(await client.callTool('tim_stats', {
      buckets: [100, 500, 1000],
    })) as { buckets: { threshold: string; count: number }[] };

    const map = Object.fromEntries(stats.buckets.map(b => [b.threshold, b.count]));
    expect(map['100']).toBe(1);
    expect(map['500']).toBe(2);
    expect(map['1000']).toBe(3);
  });
});

describe('tim_delete_batch', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-del-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('rejects empty ids list (min=1)', async () => {
    const resp = await client.callTool('tim_delete_batch', { ids: [] });
    expect(resp.result?.isError).toBe(true);
    expect(resp.result!.content[0].text).toMatch(/Error/i);
  });

  it('deletes single id', async () => {
    const written = parseResult(await client.callTool('tim_write', { content: 'gone' })) as { id: string };
    const del = parseResult(await client.callTool('tim_delete_batch', { ids: [written.id] })) as { deleted: number };
    expect(del.deleted).toBe(1);
    const stats = parseResult(await client.callTool('tim_stats')) as { totalEntries: number };
    expect(stats.totalEntries).toBe(0);
  });

  it('mixed valid+invalid ids → skips invalid, returns correct count', async () => {
    const e1 = parseResult(await client.callTool('tim_write', { content: 'one' })) as { id: string };
    const e2 = parseResult(await client.callTool('tim_write', { content: 'two' })) as { id: string };
    const del = parseResult(await client.callTool('tim_delete_batch', {
      ids: [e1.id, 'missing-id', e2.id],
    })) as { deleted: number };
    expect(del.deleted).toBe(2);
  });

  it('transactional: all-or-nothing on store failure', async () => {
    const batchDb = `/tmp/tim-del-txn-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const store = new TimStore(batchDb);
    const e1 = await store.write('keep-me-if-rollback');
    const e2 = await store.write('also-here');
    const db = store.getDb();
    let updates = 0;
    const origPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      if (typeof sql === 'string' && sql.includes('UPDATE entries SET tombstoned_at')) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          updates += 1;
          if (updates === 2) throw new Error('simulated mid-batch failure');
          return origRun(...args);
        };
      }
      return stmt;
    }) as typeof db.prepare;

    await expect(store.deleteBatch([e1.id, e2.id], true)).rejects.toThrow('simulated mid-batch failure');
    expect(await store.read(e1.id)).not.toBeNull();
    expect(await store.read(e2.id)).not.toBeNull();
    store.close();
    if (fs.existsSync(batchDb)) fs.unlinkSync(batchDb);
  });
});

describe('tim_section_children', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-section-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('lists children by parentId', async () => {
    const project = parseResult(await client.callTool('tim_create_project', {
      label: 'P7701',
      content: 'Section Test Project',
      memoryOnly: true,
    })) as { id: string };
    const section = parseResult(await client.callTool('tim_write', {
      content: 'Tasks',
      parentId: project.id,
    })) as { id: string };
    await client.callTool('tim_write', {
      content: 'Do thing\n\nbody-one',
      parentId: section.id,
      metadata: { kind: 'task' },
    });
    await client.callTool('tim_write', {
      content: 'Another task\n\nbody-two-longer',
      parentId: section.id,
      metadata: { kind: 'task' },
    });

    const result = parseResult(await client.callTool('tim_section_children', {
      parentId: section.id,
    })) as {
      parentTitle: string;
      children: { id: string; title: string; kind: string; size: number }[];
      count: number;
    };

    expect(result.parentTitle).toBe('Tasks');
    expect(result.count).toBe(2);
    expect(result.children).toHaveLength(2);
    expect(result.children.every(c => c.kind === 'task')).toBe(true);
    expect(result.children.map(c => c.size)).toEqual(expect.arrayContaining([8, 15]));
  });

  it('resolves parent via parentLabel + sectionTitle', async () => {
    const project = parseResult(await client.callTool('tim_create_project', {
      label: 'P7702',
      content: 'Resolve Project',
      memoryOnly: true,
    })) as { id: string };
    await client.callTool('tim_write', {
      content: 'Ideas',
      parentId: project.id,
    });
    await client.callTool('tim_write', {
      content: 'Spark',
      metadata: { kind: 'idea' },
      where: 'P7702/Ideas',
    });

    const result = parseResult(await client.callTool('tim_section_children', {
      parentLabel: 'P7702',
      sectionTitle: 'Ideas',
    })) as { count: number; children: { kind: string }[] };

    expect(result.count).toBe(1);
    expect(result.children[0]!.kind).toBe('idea');
  });

  it('returns empty when section not found', async () => {
    await client.callTool('tim_create_project', { label: 'P7703', content: 'Empty', memoryOnly: true });
    const result = parseResult(await client.callTool('tim_section_children', {
      parentLabel: 'P7703',
      sectionTitle: 'Missing',
    })) as { children: unknown[]; count: number };
    expect(result.count).toBe(0);
    expect(result.children).toEqual([]);
  });

  it('filters by kind', async () => {
    const project = parseResult(await client.callTool('tim_create_project', {
      label: 'P7704',
      content: 'Filter Project',
      memoryOnly: true,
    })) as { id: string };
    const section = parseResult(await client.callTool('tim_write', {
      content: 'Mixed',
      parentId: project.id,
    })) as { id: string };
    await client.callTool('tim_write', {
      content: 'task body',
      parentId: section.id,
      metadata: { kind: 'task' },
    });
    await client.callTool('tim_write', {
      content: 'idea body',
      parentId: section.id,
      metadata: { kind: 'idea' },
    });

    const result = parseResult(await client.callTool('tim_section_children', {
      parentId: section.id,
      kind: 'task',
    })) as { count: number; children: { kind: string }[] };

    expect(result.count).toBe(1);
    expect(result.children[0]!.kind).toBe('task');
  });

  it('errors when parentId and label+title both missing', async () => {
    const resp = await client.callTool('tim_section_children', {});
    expect(resp.result?.isError).toBe(true);
    expect(resp.result!.content[0].text).toMatch(/Error/i);
  });
});
