// GitHub #34 — task-aware bounded project briefings (MCP/preview regression)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { TimStore } from 'tim-store';
import { formatProjectOutput } from '../project-output.js';
import { buildBriefingRenderContext } from '../briefing-context.js';
import { estimateTextTokens } from '../briefing-budget.js';
import { loadProjectForBriefing } from '../briefing-load.js';
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

async function seedPriorityFixture(store: TimStore, label: string, logCount = 201): Promise<void> {
  const project = await store.createProject(label, { content: 'Briefing priority fixture', memoryOnly: true });

  const log = await store.write('Log', {
    parentId: project.id,
    metadata: { kind: 'section', label: 'Log', order: 1 },
  });
  for (let i = 0; i < logCount; i++) {
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
      tokenBudget: 1600,
      budget: 250,
    });
    expect(resp.result?.isError).toBeFalsy();
    const text = resp.result!.content[0].text;
    expect(text).toContain('Always use MCP');
    expect(text).toContain('Urgent briefing fix');
    expect(text).toContain('Recent Sessions');
    expect(text).toContain('Worked on briefing');
    expect(text).toMatch(/log entries omitted|… \d+ log entries omitted/);
  });

  it('keeps reserved content when Log has 1201 entries under default entry budget', async () => {
    client.kill();
    await new Promise(r => setTimeout(r, 150));
    const heavyDb = path.join(path.dirname(childServerDbPath()), `heavy-log-${Date.now()}.db`);
    if (fs.existsSync(heavyDb)) fs.unlinkSync(heavyDb);
    store = new TimStore(heavyDb);
    await seedPriorityFixture(store, 'P3403', 1201);
    store.close();
    dbPath = heavyDb;
    client = new McpClient(dbPath);
    await client.init();

    const resp = await client.callTool('tim_load_project', {
      label: 'P3403',
      bind: false,
      tokenBudget: 1600,
      budget: 200,
    });
    expect(resp.result?.isError).toBeFalsy();
    const text = resp.result!.content[0].text;
    expect(text).toContain('Always use MCP');
    expect(text).toContain('Urgent briefing fix');
    expect(text).toContain('Worked on briefing');
    expect(text).toMatch(/log entries omitted|… \d+ log entries omitted/);
  });

  it('keeps rules and tasks when a huge early non-Log section precedes them', async () => {
    client.kill();
    await new Promise(r => setTimeout(r, 150));
    const heavyDb = path.join(path.dirname(childServerDbPath()), `heavy-ideas-${Date.now()}.db`);
    if (fs.existsSync(heavyDb)) fs.unlinkSync(heavyDb);
    store = new TimStore(heavyDb);
    const project = await store.createProject('P3404', { content: 'Huge ideas fixture', memoryOnly: true });
    const ideas = await store.write('Ideas', {
      parentId: project.id,
      metadata: { kind: 'section', label: 'Ideas', order: 1 },
    });
    for (let i = 0; i < 150; i++) {
      await store.write(`Idea ${i}`, { parentId: ideas.id, content: `idea-body-${i}` });
    }
    const rules = await store.write('Rules', {
      parentId: project.id,
      metadata: { kind: 'section', label: 'Rules', order: 2 },
    });
    await store.write('Critical rule text', {
      parentId: rules.id,
      tags: ['#rule'],
      metadata: { type: 'rule', rule: { action: 'never drop rules' } },
    });
    const tasks = await store.write('Tasks', {
      parentId: project.id,
      metadata: { kind: 'section', label: 'Tasks', order: 900 },
    });
    await store.write('Starved task title', {
      parentId: tasks.id,
      metadata: { task: { status: 'todo', priority: 'high', order: 1 } },
      content: 'Must appear despite Ideas volume',
    });
    store.close();
    dbPath = heavyDb;
    client = new McpClient(dbPath);
    await client.init();

    const resp = await client.callTool('tim_load_project', {
      label: 'P3404',
      bind: false,
      tokenBudget: 500,
      budget: 200,
    });
    const text = resp.result!.content[0].text;
    expect(text).toContain('Critical rule text');
    expect(text).toContain('Starved task title');
  });

  it('includes query-relevant extras and excludes adversarial other-project hits', async () => {
    const resp = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: false,
      tokenBudget: 3200,
      query: 'UniqueAlphaNeedleToken',
    });
    const text = resp.result!.content[0].text;
    expect(text).toContain('Task context');
    expect(text).toContain('UniqueAlphaNeedleToken');
    expect(text).not.toContain('Foreign UniqueAlphaNeedleToken');
  });

  it('rejects invalid tokenBudget values', async () => {
    for (const bad of [0, -5, Number.NaN, 1.2, 70000]) {
      const resp = await client.callTool('tim_load_project', {
        label: 'P3400',
        bind: false,
        tokenBudget: bad,
      });
      expect(resp.result?.isError).toBe(true);
    }
  });

  it('accepts explicit default config budget 9000', async () => {
    const resp = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: false,
      tokenBudget: 9000,
    });
    expect(resp.result?.isError).toBeFalsy();
    expect(resp.result!.content[0].text).toContain('Always use MCP');
  });

  it('returns deterministic rendered output for repeated calls', async () => {
    const args = { label: 'P3400', bind: false, tokenBudget: 350, query: 'UniqueAlphaNeedleToken' };
    const a = await client.callTool('tim_load_project', args);
    const b = await client.callTool('tim_load_project', args);
    expect(a.result!.content[0].text).toBe(b.result!.content[0].text);
  });

  it('preview briefing uses the same selection contract as load for query extras', async () => {
    const load = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: false,
      tokenBudget: 2000,
      query: 'UniqueAlphaNeedleToken',
    });
    const preview = await client.callTool('tim_preview_briefing', {
      project: 'P3400',
      tokenBudget: 2000,
      query: 'UniqueAlphaNeedleToken',
    });
    const loadText = load.result!.content[0].text;
    const previewText = preview.result!.content[0].text;
    expect(loadText).toContain('Task context');
    expect(loadText).toContain('UniqueAlphaNeedleToken');
    expect(previewText).toContain('Task context');
    expect(previewText).toContain('UniqueAlphaNeedleToken');
    expect(previewText).toContain('── directive');
    // Both must retain query needle under the same budget (preview no longer drops extras via tail clamp).
    expect(loadText).not.toContain('Foreign UniqueAlphaNeedleToken');
    expect(previewText).not.toContain('Foreign UniqueAlphaNeedleToken');
  });

  it('preserves legacy shape when no query is requested', async () => {
    const resp = await client.callTool('tim_load_project', { label: 'P3400', bind: false });
    const text = resp.result!.content[0].text;
    expect(text).toContain('── Sections');
    expect(text).not.toContain('Task context');
  });

  it('bounds tiny Unicode budgets with explicit omission markers', async () => {
    const resp = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: false,
      tokenBudget: 8,
    });
    const text = resp.result!.content[0].text;
    expect(text.length).toBeGreaterThan(0);
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(8);
    expect(text).toMatch(/truncated|omitted|…|Rules/);
  });

  it('default tim_load_project output respects 12 KB contract when tokenBudget omitted', async () => {
    client.kill();
    await new Promise(r => setTimeout(r, 150));
    const legacyDb = path.join(path.dirname(childServerDbPath()), `legacy-wide-${Date.now()}.db`);
    if (fs.existsSync(legacyDb)) fs.unlinkSync(legacyDb);
    store = new TimStore(legacyDb);
    const project = await store.createProject('P3499', { content: 'Legacy wide fixture', memoryOnly: true });
    for (let s = 0; s < 20; s++) {
      const section = await store.write(`Section ${s}`, {
        parentId: project.id,
        metadata: { kind: 'section', label: `Section ${s}`, order: s },
      });
      for (let e = 0; e < 10; e++) {
        await store.write(`Entry ${s}-${e} with a realistic ninety character title padding text`, {
          parentId: section.id,
          content: `body-${s}-${e}`,
        });
      }
    }
    store.close();
    dbPath = legacyDb;
    client = new McpClient(dbPath);
    await client.init();

    const resp = await client.callTool('tim_load_project', {
      label: 'P3499',
      bind: false,
      depth: 3,
      budget: 200,
    });
    const text = resp.result!.content[0].text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(12288);
    expect(text).toContain('Use tim_read');
  });

  it('reserves footer and NEXT hint under explicit token budgets', async () => {
    const resp = await client.callTool('tim_load_project', {
      label: 'P3400',
      bind: true,
      tokenBudget: 9000,
      budget: 200,
    });
    const text = resp.result!.content[0].text;
    expect(text).toContain('Use tim_read');
    expect(text).toContain('NEXT:');
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(9000);
  });

  it('includes directive preview body under default byte budget with long session rollup', async () => {
    client.kill();
    await new Promise(r => setTimeout(r, 150));
    const previewDb = path.join(path.dirname(childServerDbPath()), `preview-directive-${Date.now()}.db`);
    if (fs.existsSync(previewDb)) fs.unlinkSync(previewDb);
    store = new TimStore(previewDb);
    const project = await store.createProject('P9004', { content: 'Preview directive fixture', memoryOnly: true });
    const sessionsRoot = await store.write('Sessions', {
      parentId: project.id,
      metadata: { kind: 'sessions-root', order: 1, render_depth: 0 },
      tags: ['#sessions'],
    });
    const session = await store.write('Preview session', {
      parentId: sessionsRoot.id,
      metadata: { kind: 'session', sessionId: 'sess-preview-1', exchange_count: 5 },
      tags: ['#session'],
    });
    await store.write('Summary', {
      parentId: session.id,
      metadata: {
        kind: 'session-summary-root',
        exchanges: 5,
        summary: 'A'.repeat(11169),
      },
      tags: ['#session-summary'],
    });
    store.close();
    dbPath = previewDb;
    client = new McpClient(dbPath);
    await client.init();

    const resp = await client.callTool('tim_preview_briefing', { project: 'P9004' });
    const text = resp.result!.content[0].text;
    expect(text).toContain('── directive (what a start hook emits) ──');
    expect(text).not.toMatch(/preview-directive: omitted \(token budget\)/);
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(9000);
  });

  it('preserves maxTokens:0 legacy directive suppression on preview', async () => {
    const resp = await client.callTool('tim_preview_briefing', {
      project: 'P3400',
      maxTokens: 0,
    });
    const text = resp.result!.content[0].text;
    expect(text).not.toContain('── directive (what a start hook emits) ──');
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

  it('load mode with context renders Tasks index line and Now block, not full Tasks body', async () => {
    const project = (await store.read('P3402'))!;
    const sessionsRoot = (await store.getChildren(project.id))
      .find(entry => entry.metadata.kind === 'sessions-root')!;
    for (let i = 0; i < 220; i++) {
      const session = await store.write(`Additional session ${i}`, {
        parentId: sessionsRoot.id, metadata: { kind: 'session' },
      });
      await store.write('Latest work summary', {
        parentId: session.id,
        metadata: { kind: 'session-summary-root', summary: 'Current handoff' },
        tags: ['#session-summary'],
      });
    }
    const result = (await loadProjectForBriefing(store, 'P3402', { depth: 4, budget: 40 }))!;
    expect(result.children.length).toBeLessThanOrEqual(40);
    const briefingContext = await buildBriefingRenderContext(
      store, 'P3402', result.project.id, 3,
    );
    const output = formatProjectOutput(result, 40, undefined, 'load', 3, {
      tokenBudget: 9000,
      briefingContext,
    });
    expect(output).toContain('Always use MCP');
    expect(output).toContain('Urgent briefing fix');
    expect(output).toContain('Tasks (');
    expect(output).not.toContain('Must appear despite Ideas volume');
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

describe('recent session dates', () => {
  it('shows a start–last range for a session active past its start day', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-range-'));
    const store = new TimStore(path.join(dir, 'tim.db'));
    try {
      const project = await store.createProject('P3499', { content: 'range', memoryOnly: true });
      const sessionsRoot = await store.write('Sessions', {
        parentId: project.id, metadata: { kind: 'sessions-root' },
      });
      const session = await store.write('Long session', {
        parentId: sessionsRoot.id,
        metadata: { kind: 'session', date: '2020-01-01T10:00:00.000Z', exchange_count: 5 },
      });
      await store.write('late exchange', { parentId: session.id, metadata: { kind: 'exchange' } });
      const ctx = await buildBriefingRenderContext(store, 'P3499', project.id, 3);
      expect(ctx.recentSessions?.[0]?.date).toMatch(/^2020-01-01 – \d{4}-\d{2}-\d{2}$/);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
