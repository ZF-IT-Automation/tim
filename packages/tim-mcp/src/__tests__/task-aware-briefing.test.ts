// GitHub #34 — task-aware bounded project briefings (MCP/preview regression)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TimStore } from 'tim-store';
import { formatProjectOutput } from '../project-output.js';
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
      }, 30000);
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
      clientInfo: { name: 'task-aware-briefing-test', version: '0.0.1' },
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

async function seedPriorityFixture(store: TimStore, label: string): Promise<void> {
  const project = await store.createProject(label, { content: 'Briefing priority fixture', memoryOnly: true });

  const log = await store.write('Log', {
    parentId: project.id,
    metadata: { kind: 'section', label: 'Log', order: 1 },
  });
  for (let i = 0; i < 201; i++) {
    await store.write(`Log filler ${i}`, { parentId: log.id, content: `noise-${i}` });
  }

  const rules = await store.write('Rules', {
    parentId: project.id,
    metadata: { kind: 'section', label: 'Rules', order: 2 },
  });
  await store.write('Always use MCP', {
    parentId: rules.id,
    tags: ['#rule'],
    metadata: { type: 'rule', rule: { action: 'use MCP tools' } },
  });

  const tasks = await store.write('Tasks', {
    parentId: project.id,
    metadata: { kind: 'section', label: 'Tasks', order: 900 },
  });
  await store.write('Urgent briefing fix', {
    parentId: tasks.id,
    metadata: { task: { status: 'todo', priority: 'high', order: 10 } },
    content: 'Must survive log volume',
  });

  const sessionsRoot = await store.write('Sessions', {
    parentId: project.id,
    metadata: { kind: 'sessions-root', order: 1000, render_depth: 0 },
    tags: ['#sessions'],
  });
  const session = await store.write('Latest session', {
    parentId: sessionsRoot.id,
    metadata: { kind: 'session', sessionId: 'sess-latest', exchange_count: 3 },
    tags: ['#session'],
  });
  await store.write('Summary', {
    parentId: session.id,
    metadata: {
      kind: 'session-summary-root',
      exchanges: 3,
      summary: 'Worked on briefing\nnext: ship #34',
    },
    tags: ['#session-summary'],
  });
  await store.write('UniqueAlphaNeedleToken for task query', {
    parentId: tasks.id,
    title: 'QueryRelevantNeedle',
    metadata: { task: { status: 'todo', priority: 'low', order: 999 } },
  });

  const other = await store.createProject('P3401', { content: 'Other', memoryOnly: true });
  await store.write('Foreign UniqueAlphaNeedleToken', {
    parentId: other.id,
    content: 'Should not appear in P3400 brief',
  });
}

describe('task-aware briefing MCP contract', () => {
  let client: McpClient;
  let dbPath: string;
  let store: TimStore;

  beforeEach(async () => {
    dbPath = childServerDbPath();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    store = new TimStore(dbPath);
    await seedPriorityFixture(store, 'P3400');
    store.close();
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('keeps rules, urgent tasks and recent session when Log has 201 entries', async () => {
    const resp = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: false,
      tokenBudget: 400,
      budget: 250,
    });
    expect(resp.result?.isError).toBeFalsy();
    const text = resp.result!.content[0].text;
    expect(text).toContain('Always use MCP');
    expect(text).toContain('Urgent briefing fix');
    expect(text).toContain('Recent Sessions');
    expect(text).toMatch(/log entries omitted|… \d+ log entries omitted/);
  });

  it('includes query-relevant extras and excludes adversarial other-project hits', async () => {
    const resp = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: false,
      tokenBudget: 800,
      query: 'UniqueAlphaNeedleToken',
    });
    const text = resp.result!.content[0].text;
    expect(text).toContain('Task context');
    expect(text).toContain('UniqueAlphaNeedleToken');
    expect(text).not.toContain('Foreign UniqueAlphaNeedleToken');
  });

  it('rejects invalid tokenBudget values', async () => {
    for (const bad of [0, -5, Number.NaN, 1.2, 5000]) {
      const resp = await client.callTool('tim_load_project', {
        label: 'P3400',
        bind: false,
        tokenBudget: bad,
      });
      expect(resp.result?.isError).toBe(true);
    }
  });

  it('returns deterministic rendered output for repeated calls', async () => {
    const args = { label: 'P3400', bind: false, tokenBudget: 350, query: 'UniqueAlphaNeedleToken' };
    const a = await client.callTool('tim_load_project', args);
    const b = await client.callTool('tim_load_project', args);
    expect(a.result!.content[0].text).toBe(b.result!.content[0].text);
  });

  it('preview briefing uses the same query extras without binding', async () => {
    const preview = await client.callTool('tim_preview_briefing', {
      project: 'P3400',
      tokenBudget: 500,
      query: 'UniqueAlphaNeedleToken',
    });
    const text = preview.result!.content[0].text;
    expect(text).toContain('Task context');
    expect(text).toContain('UniqueAlphaNeedleToken');
    expect(text).toContain('── directive');
  });

  it('preserves legacy shape when no query is requested', async () => {
    const resp = await client.callTool('tim_load_project', { label: 'P3400', bind: false });
    const text = resp.result!.content[0].text;
    expect(text).toContain('── Sections');
    expect(text).not.toContain('Task context');
  });

  it('bounds tiny Unicode budgets', async () => {
    const resp = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: false,
      tokenBudget: 8,
    });
    const text = resp.result!.content[0].text;
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/truncated|omitted|…/);
  });
});

describe('formatProjectOutput task-aware unit seam', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-task-aware-unit-${Date.now()}.db`;
    store = new TimStore(dbPath);
    await seedPriorityFixture(store, 'P3402');
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('respects suppression for query extras', async () => {
    const tasks = (await store.getChildren((await store.read('P3402'))!.id))
      .find(c => c.title === 'Tasks')!;
    await store.write('SecretSuppressedNeedle token in body', {
      parentId: tasks.id,
      title: 'Suppressed needle',
    });
    await store.suppress('SecretSuppressedNeedle', 'test');

    const loaded = await store.loadProject('P3402', { depth: 4, budget: 300 })!;
    const hits = await store.search({
      query: 'SecretSuppressedNeedle',
      project: 'P3402',
      topK: 5,
      searchType: 'fts',
    });
    expect(hits).toHaveLength(0);

    const out = formatProjectOutput(loaded, 200, undefined, 'load', 3, {
      tokenBudget: 500,
      query: 'SecretSuppressedNeedle',
      queryExtras: hits,
    });
    expect(out).not.toContain('SecretSuppressedNeedle');
  });
});
