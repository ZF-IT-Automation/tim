import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { TimStore } from 'tim-store';
import { countProjectOpenBugs } from 'tim-hooks';
import { formatProjectOutput } from '../project-output.js';

describe('tim_load_project layout (C6)', () => {
  const project = {
    id: 'P1',
    parentId: null,
    metadata: { label: 'P1', kind: 'project', access_count: 0 },
    title: 'P1 — Demo | Active',
    content: '## Project Summary\n- summary bullet one\n- summary bullet two',
    tags: [],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  } as any;

  const overview = {
    id: 'overview',
    parentId: 'P1',
    title: 'Overview',
    metadata: { kind: 'section', order: 1 },
    tags: [],
    content: 'Overview line one.\nOverview line two.',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  const rules = {
    id: 'rules',
    parentId: 'P1',
    title: 'Rules',
    metadata: { kind: 'section', order: 2 },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  const bugs = {
    id: 'bugs',
    parentId: 'P1',
    title: 'Bugs',
    metadata: { kind: 'section', order: 3 },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  const tasks = {
    id: 'tasks',
    parentId: 'P1',
    title: 'Tasks',
    metadata: { kind: 'section', order: 4 },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;

  function lineIndex(text: string, needle: string): number {
    const idx = text.indexOf(needle);
    expect(idx).toBeGreaterThanOrEqual(0);
    return text.slice(0, idx).split('\n').length;
  }

  it('orders header → overview → Now → Rules → Project Summary → Sections index', () => {
    const ruleChild = {
      id: 'rule-1',
      parentId: 'rules',
      title: 'Use MCP',
      metadata: { type: 'rule' },
      tags: ['#rule'],
      content: 'Always call tim_write for durable notes.',
      createdAt: '2026-06-01T00:00:00Z',
    } as any;

    const out = formatProjectOutput(
      {
        project,
        children: [overview, rules, ruleChild, bugs, tasks],
        truncated: false,
      },
      200,
      undefined,
      'load',
      3,
      {
        tokenBudget: 12000,
        briefingContext: {
          lastActivityDate: '2026-06-01',
          nowBlockLines: [
            '', '── Now ──', '', '- [todo, high] Fix the renderer',
            '+ 2 more open tasks — tim_show', 'Stale = untouched over 7+ days', '- [todo] Old · stale since 2026-01-01',
          ],
          openTaskCounts: { open: 1, stale: 0 },
          openBugCount: 2,
        },
      },
    );

    const headerLine = lineIndex(out, 'Overview line one.');
    const nowLine = lineIndex(out, '── Now ──');
    const rulesLine = lineIndex(out, '── Rules ──');
    const summaryLine = lineIndex(out, '── Project Summary ──');
    const sectionsLine = lineIndex(out, '── Sections');

    expect(headerLine).toBeLessThan(nowLine);
    expect(nowLine).toBeLessThan(rulesLine);
    expect(rulesLine).toBeLessThan(summaryLine);
    expect(summaryLine).toBeLessThan(sectionsLine);
    expect(nowLine).toBeLessThan(20);
    expect(out).toContain('+ 2 more open tasks');
    expect(out).toContain('Stale = untouched over 7+ days');
  });

  it('counts open bugs from briefingContext when section children are not loaded', () => {
    const out = formatProjectOutput(
      { project, children: [overview, bugs], truncated: false },
      200,
      undefined,
      'load',
      3,
      {
        tokenBudget: 12000,
        briefingContext: {
          lastActivityDate: '2026-06-01',
          openBugCount: 7,
        },
      },
    );
    expect(out).toContain('Bugs (7 open)');
  });

  it('renders rules as compact single lines with tim_read for multi-paragraph bodies', () => {
    const longRule = {
      id: 'rule-long',
      parentId: 'rules',
      title: 'The rule',
      metadata: { type: 'rule' },
      tags: ['#rule'],
      content: '## The rule\n\nFirst visible line.\n\nSecond paragraph must not leak.',
      createdAt: '2026-06-01T00:00:00Z',
    } as any;

    const out = formatProjectOutput(
      { project, children: [rules, longRule], truncated: false },
      200,
      undefined,
      'load',
      3,
      {
        tokenBudget: 12000,
        briefingContext: { lastActivityDate: '2026-06-01' },
      },
    );

    expect(out).toContain('The rule: First visible line.');
    expect(out).toContain('tim_read("rule-long")');
    expect(out).not.toContain('Second paragraph must not leak');
    expect(out).not.toContain('## The rule');
  });
});

describe('countProjectOpenBugs fixture shapes', () => {
  let store: TimStore;
  let dbPath: string;
  let project: Awaited<ReturnType<TimStore['createProject']>>;

  beforeEach(async () => {
    dbPath = `/tmp/tim-bug-count-${Date.now()}.db`;
    store = new TimStore(dbPath);
    project = await store.createProject('Pbugs', { content: 'bug count fixture', memoryOnly: true });
    const bugsSection = await store.write('Bugs', {
      parentId: project.id,
      metadata: { kind: 'section', label: 'Bugs', order: 1 },
    });

    await store.write('Open via bug object', {
      parentId: bugsSection.id,
      tags: ['#bug'],
      metadata: { bug: { status: 'open', severity: 'medium' } },
    });
    await store.write('Open legacy type', {
      parentId: bugsSection.id,
      metadata: { type: 'bug', status: 'open', severity: 'P2' },
    });
    await store.write('Fixed bug', {
      parentId: bugsSection.id,
      tags: ['#bug'],
      metadata: { bug: { status: 'fixed', severity: 'P3' } },
    });
    await store.write('Closed legacy', {
      parentId: bugsSection.id,
      metadata: { type: 'bug', status: 'resolved' },
    });
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('counts only open bugs across metadata shapes', async () => {
    expect(await countProjectOpenBugs(store, 'Pbugs')).toBe(2);

    const bugsSection = (await store.getChildren(project.id))
      .find(entry => entry.title === 'Bugs')!;
    const out = formatProjectOutput(
      { project, children: [bugsSection], truncated: false },
      50,
      undefined,
      'load',
      3,
      {
      tokenBudget: 12000,
        briefingContext: {
          lastActivityDate: '2026-06-01',
          openBugCount: 2,
        },
      },
    );
    expect(out).toContain('Bugs (2 open)');
  });
});
