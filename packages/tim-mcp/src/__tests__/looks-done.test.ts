import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimStore } from 'tim-store';
import { suggestLooksDone } from '../looks-done.js';

const NOUL = { type: 'noul' as const };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JEV_API_KEY;
});

async function projectWithTasks(
  store: TimStore,
  titles: Array<{ title: string; status?: string; body?: string }>,
) {
  await store.createProject('P9001', { content: 'Looks done fixture' });
  const project = (await store.read('P9001'))!;
  const entries = [];
  for (const row of titles) {
    const content = row.body ? `${row.title}\n${row.body}` : row.title;
    entries.push(await store.write(content, {
      parentId: project.id,
      metadata: { type: 'task', task: { status: row.status ?? 'todo' } },
      tags: ['#task', '#test'],
    }));
  }
  return entries;
}

function stubNoul(byKey: Record<string, number>) {
  const calls: Array<{ state: { cases: Array<{ id: string; task: { title: string; body: string }; evidence: string[] }> }; questions: Record<string, { instructions: string }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as (typeof calls)[number];
    calls.push(body);
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const key of Object.keys(body.questions)) {
      answers[key] = { type: 'noul', noul: byKey[key] ?? 0 };
    }
    return new Response(JSON.stringify({ answers }));
  }));
  return calls;
}

describe('suggestLooksDone', () => {
  it('lists noul at or above 0.70 and omits the rest', async () => {
    process.env.JEV_API_KEY = 'k';
    const store = new TimStore(':memory:');
    const [high, low, edge] = await projectWithTasks(store, [
      { title: 'Ship export rotation' },
      { title: 'Keep parser open' },
      { title: 'Borderline indexer' },
    ]);
    stubNoul({ t0: 0.8, t1: 0.6, t2: 0.7 });

    const text = await suggestLooksDone(store, [high, low, edge]);

    expect(text).toContain('nothing was changed');
    expect(text).toContain(high.id);
    expect(text).toContain('noul=0.8');
    expect(text).toContain(edge.id);
    expect(text).toContain('noul=0.7');
    expect(text).not.toContain(low.id);
    expect(text).not.toContain('Keep parser open');
    store.close();
  });

  it('sends batches of six, strips status words, and cites evidence ids', async () => {
    process.env.JEV_API_KEY = 'k';
    const store = new TimStore(':memory:');
    const project = await (async () => {
      await store.createProject('P9001', { content: 'Looks done fixture' });
      return (await store.read('P9001'))!;
    })();
    const task = await store.write(
      'Repair checkpoint rotation\nSTATUS: DONE\nThe rotation is still open.\nerledigt leftover and fixed wording',
      {
        parentId: project.id,
        metadata: { type: 'task', task: { status: 'todo' } },
        tags: ['#task', '#test'],
      },
    );
    const commit = await store.write('checkpoint rotation\nShipped the checkpoint rotation repair.', {
      parentId: project.id,
      metadata: { kind: 'commit' },
      tags: ['#commit', '#test'],
    });
    const log = await store.write('checkpoint rotation\nLog records the rotation repair shipped.', {
      parentId: project.id,
      metadata: { type: 'log' },
      tags: ['#log', '#test'],
    });
    const decision = await store.write('checkpoint rotation\nDecision: rotation repair is in production.', {
      parentId: project.id,
      metadata: { type: 'decision' },
      tags: ['#decision', '#test'],
    });
    const summary = await store.write('checkpoint rotation\nBatch notes the rotation repair shipped.', {
      parentId: project.id,
      metadata: { kind: 'batch-summary' },
      tags: ['#batch-summary', '#test'],
    });
    const note = await store.write('checkpoint rotation\nPlain note that must not count as evidence.', {
      parentId: project.id,
      tags: ['#note', '#test'],
    });
    const filler = [];
    for (let i = 0; i < 6; i++) {
      filler.push(await store.write(`Unrelated open task ${i}`, {
        parentId: project.id,
        metadata: { type: 'task', task: { status: 'todo' } },
        tags: ['#task', '#test'],
      }));
    }
    const done = await store.write('Repair checkpoint rotation done copy', {
      parentId: project.id,
      metadata: { type: 'task', task: { status: 'done' } },
      tags: ['#task', '#test'],
    });

    const calls = stubNoul({ t0: 0.8, t1: 0.1, t2: 0.1, t3: 0.1, t4: 0.1, t5: 0.1 });
    const text = await suggestLooksDone(store, [task, ...filler, done]);

    expect(calls).toHaveLength(2);
    expect(calls[0].state.cases).toHaveLength(6);
    expect(calls[1].state.cases).toHaveLength(1);
    expect(calls[0].state.cases[0].id).toBe('T0');
    expect(calls[1].state.cases[0].id).toBe('T0');
    expect(calls[0].questions.t0.instructions).toBe(
      'Does the evidence show that task T0 was already implemented, fixed or shipped?',
    );
    const sentBody = calls[0].state.cases[0].task.body;
    expect(sentBody).not.toMatch(/status\s*:/i);
    expect(sentBody.toLowerCase()).not.toContain('erledigt');
    expect(sentBody.toLowerCase()).not.toContain('fixed');
    expect(sentBody).toContain('still open');
    const evidence = calls[0].state.cases[0].evidence.join('\n');
    expect(evidence).toContain(commit.title);
    expect(evidence).toContain('—');
    expect(text).toContain(task.id);
    expect(text).toContain(commit.id);
    expect(text).toContain(log.id);
    expect(text).toContain(decision.id);
    expect(text).toContain(summary.id);
    expect(text).not.toContain(note.id);
    expect(text).not.toContain(done.id);
    expect(calls[0].state.cases.map(row => row.task.title)).not.toContain(done.title);
    store.close();
  });

  it('says it could not judge the batch when Jev returns null', async () => {
    process.env.JEV_API_KEY = 'k';
    const store = new TimStore(':memory:');
    const [task] = await projectWithTasks(store, [
      { title: 'Ship export rotation' },
      { title: 'Second open task' },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 429 })));

    const text = await suggestLooksDone(store, [task]);

    expect(text).toContain('could not judge 1 tasks (Jev unavailable)');
    expect(text).not.toContain(task.id);
    expect(text).toContain('nothing was changed');
    store.close();
  });
});
