import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TimStore, titleSimilarity } from '../index.js';

const SAME_FACT =
  'Do A and B record the same fact or task, so that one can be dropped without losing a distinct fact? A different date, version, subject or a follow-up is not the same fact.';

describe('ConsolidationManager duplicates', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  async function seedProject(label: string) {
    return store.createProject(label, { content: `${label} — Test | Active` });
  }

  it('finds title-similar pairs and enqueues curation entries', async () => {
    const project = await seedProject('P0200');
    await store.write('Reminder System Cron Checker\nNotes A.', {
      parentId: project.id,
      tags: ['#reminder', '#cron'],
    });
    await store.write('Reminder System via Cron Checker\nNotes B.', {
      parentId: project.id,
      tags: ['#reminder', '#design'],
    });

    const mgr = store.consolidate();
    const hits = await mgr.findDuplicateCandidates('P0200');
    expect(hits.length).toBe(1);
    expect(hits[0]!.consolidation).toBe('duplicate');
    expect(hits[0]!.pair).toHaveLength(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0.6);

    const queue = await mgr.getCurationQueue('P0200', 'pending');
    expect(queue).toHaveLength(1);
    expect(queue[0]!.metadata.consolidation).toBe('duplicate');
  });

  it('enqueue is idempotent for the same pair', async () => {
    const project = await seedProject('P0201');
    const a = await store.write('Shared Topic Alpha\nA.', {
      parentId: project.id,
      tags: ['#alpha', '#beta'],
    });
    const b = await store.write('Shared Topic Alpha v2\nB.', {
      parentId: project.id,
      tags: ['#alpha', '#beta'],
    });
    expect(titleSimilarity(a.title, b.title)).toBeGreaterThanOrEqual(0.6);

    const mgr = store.consolidate();
    const first = await mgr.findDuplicateCandidates('P0201');
    const second = await mgr.findDuplicateCandidates('P0201');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.id).toBe(second[0]!.id);

    const queue = await mgr.getCurationQueue('P0201', 'pending');
    expect(queue).toHaveLength(1);
  });

  it('uses cosine similarity when embeddings exist', async () => {
    const project = await seedProject('P0202');
    const a = await store.write('Unrelated title A\nSemantic body about databases.', {
      parentId: project.id,
      tags: ['#db', '#sql'],
    });
    const b = await store.write('Different title B\nSemantic body about databases.', {
      parentId: project.id,
      tags: ['#db', '#sql'],
    });

    const vec = new Float32Array([1, 0, 0, 0]);
    store.setVectors(a.id, vec, 'test');
    store.setVectors(b.id, vec, 'test');

    const mgr = store.consolidate();
    const hits = await mgr.findDuplicateCandidates('P0202', { threshold: 0.8 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0.8);
    expect(hits[0]!.pair).toContain(a.id);
    expect(hits[0]!.pair).toContain(b.id);
  });

  it('getCurationStats counts by status and type', async () => {
    const project = await seedProject('P0203');
    await store.write('Idea one\nx', { parentId: project.id, tags: ['#a', '#b'] });
    await store.write('Idea one copy\ny', { parentId: project.id, tags: ['#a', '#b'] });

    const mgr = store.consolidate();
    await mgr.findDuplicateCandidates('P0203');
    const stats = await mgr.getCurationStats('P0203');
    expect(stats['duplicate:pending']).toBe(1);

    const queue = await mgr.getCurationQueue('P0203', 'pending');
    await mgr.setCurationDone(queue[0]!.id);
    const after = await mgr.getCurationStats('P0203');
    expect(after['duplicate:done']).toBe(1);
  });
});

describe('ConsolidationManager decay', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  async function seedProject(label: string) {
    return store.createProject(label, { content: `${label} — Decay | Active` });
  }

  it('queues stale low-access entries', async () => {
    const project = await seedProject('P0300');
    const staleDate = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const oldVerified = new Date(Date.now() - 60 * 86_400_000).toISOString();

    const entry = await store.write('Stale note\nForgotten.', {
      parentId: project.id,
      tags: ['#old', '#note'],
    });
    store.getDb().prepare(
      `UPDATE entries SET accessed_at = ?, updated_at = ?, metadata = ? WHERE id = ?`,
    ).run(
      staleDate,
      oldVerified,
      JSON.stringify({ verified_at: oldVerified }),
      entry.id,
    );

    const mgr = store.consolidate();
    const hits = await mgr.findDecayCandidates('P0300');
    expect(hits.some(h => h.target === entry.id)).toBe(true);

    const queue = await mgr.getCurationQueue('P0300', 'pending');
    expect(queue.some(q => q.metadata.target === entry.id)).toBe(true);
  });

  it('skips recently accessed entries', async () => {
    const project = await seedProject('P0301');
    await store.write('Fresh note\nActive.', {
      parentId: project.id,
      tags: ['#fresh', '#note'],
    });

    const mgr = store.consolidate();
    const hits = await mgr.findDecayCandidates('P0301');
    expect(hits).toHaveLength(0);
  });

  it('skips entries with fresh edges to other content', async () => {
    const project = await seedProject('P0302');
    const staleDate = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const oldVerified = new Date(Date.now() - 60 * 86_400_000).toISOString();

    const stale = await store.write('Stale linked\nx', {
      parentId: project.id,
      tags: ['#old', '#link'],
    });
    const fresh = await store.write('Fresh neighbor\ny', {
      parentId: project.id,
      tags: ['#new', '#link'],
    });
    await store.link(stale.id, fresh.id, 'relates');

    store.getDb().prepare(
      `UPDATE entries SET accessed_at = ?, updated_at = ?, metadata = ? WHERE id = ?`,
    ).run(
      staleDate,
      oldVerified,
      JSON.stringify({ verified_at: oldVerified }),
      stale.id,
    );

    const mgr = store.consolidate();
    const hits = await mgr.findDecayCandidates('P0302');
    expect(hits.some(h => h.target === stale.id)).toBe(false);
  });

  it('decay enqueue is idempotent per target', async () => {
    const project = await seedProject('P0303');
    const staleDate = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const oldVerified = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const entry = await store.write('Once stale\nz', {
      parentId: project.id,
      tags: ['#z', '#w'],
    });
    store.getDb().prepare(
      `UPDATE entries SET accessed_at = ?, updated_at = ?, metadata = ? WHERE id = ?`,
    ).run(
      staleDate,
      oldVerified,
      JSON.stringify({ verified_at: oldVerified }),
      entry.id,
    );

    const mgr = store.consolidate();
    const a = await mgr.findDecayCandidates('P0303');
    const b = await mgr.findDecayCandidates('P0303');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});

describe('findDuplicateCandidates Jev confirmation', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
    delete process.env.JEV_API_KEY;
  });

  afterEach(() => {
    store.close();
    vi.unstubAllGlobals();
    delete process.env.JEV_API_KEY;
  });

  async function seedPair(label: string, bodyA = 'Notes A.') {
    const project = await store.createProject(label, { content: `${label} — Test | Active` });
    const a = await store.write(`Reminder System Cron Checker\n${bodyA}`, {
      parentId: project.id,
      tags: ['#reminder', '#cron'],
    });
    const b = await store.write('Reminder System via Cron Checker\nNotes B.', {
      parentId: project.id,
      tags: ['#reminder', '#design'],
    });
    return { a, b };
  }

  function stubNoul(noul: number) {
    process.env.JEV_API_KEY = 'test-key';
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) =>
      new Response(JSON.stringify({ answers: { same: { type: 'noul', noul } } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('enqueues a pair Jev confirms and records the noul', async () => {
    const { a, b } = await seedPair('P0410', 'n'.repeat(2000));
    const fetchMock = stubNoul(0.93);

    const hits = await store.consolidate().findDuplicateCandidates('P0410');
    expect(hits).toHaveLength(1);
    expect(hits.confirmed).toBe(1);
    expect(hits.rejected).toBe(0);
    expect(hits.unconfirmed).toBe(0);
    expect(hits[0]!.reason).toContain('jev=0.93');

    const queue = await store.consolidate().getCurationQueue('P0410', 'pending');
    expect(queue).toHaveLength(1);
    expect(queue[0]!.metadata.jev).toBe(0.93);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    expect(sent.state).toEqual({
      a: { title: low.title, body: low.content.slice(0, 1500) },
      b: { title: high.title, body: high.content.slice(0, 1500) },
    });
    expect(sent.questions).toEqual({
      same: { type: 'noul', instructions: SAME_FACT },
    });
    expect(sent.state.a.body.length).toBeLessThanOrEqual(1500);
    expect(sent.state.b.body.length).toBeLessThanOrEqual(1500);
  });

  it('enqueues when noul is exactly 0.70', async () => {
    await seedPair('P0411');
    stubNoul(0.7);
    const hits = await store.consolidate().findDuplicateCandidates('P0411');
    expect(hits).toHaveLength(1);
    expect(hits.confirmed).toBe(1);
    expect(hits[0]!.reason).toContain('jev=0.70');
    const queue = await store.consolidate().getCurationQueue('P0411', 'pending');
    expect(queue[0]!.metadata.jev).toBe(0.7);
  });

  it('does not enqueue a pair Jev rejects and counts it', async () => {
    await seedPair('P0412');
    stubNoul(0.69);
    const hits = await store.consolidate().findDuplicateCandidates('P0412');
    expect(hits).toHaveLength(0);
    expect(hits.confirmed).toBe(0);
    expect(hits.rejected).toBe(1);
    expect(hits.unconfirmed).toBe(0);
    const queue = await store.consolidate().getCurationQueue('P0412', 'pending');
    expect(queue).toHaveLength(0);
  });

  it('does not queue a pair Jev could not judge, and asks again next run', async () => {
    await seedPair('P0413');
    process.env.JEV_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 500 })));

    const hits = await store.consolidate().findDuplicateCandidates('P0413');
    expect(hits).toHaveLength(0);
    expect(hits.unconfirmed).toBe(1);
    expect(await store.consolidate().getCurationQueue('P0413', 'pending')).toHaveLength(0);

    const fetchMock = stubNoul(0.9);
    const again = await store.consolidate().findDuplicateCandidates('P0413');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.confirmed).toBe(1);
  });

  it('remembers a Jev rejection and does not ask again', async () => {
    await seedPair('P0417');
    stubNoul(0.2);
    expect((await store.consolidate().findDuplicateCandidates('P0417')).rejected).toBe(1);

    const fetchMock = stubNoul(0.99);
    const again = await store.consolidate().findDuplicateCandidates('P0417');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(again).toHaveLength(0);
    expect(again.rejected).toBe(1);
    expect(await store.consolidate().getCurationQueue('P0417', 'pending')).toHaveLength(0);
  });

  it('without a Jev key queues exactly as before and never calls fetch', async () => {
    await seedPair('P0418');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const hits = await store.consolidate().findDuplicateCandidates('P0418');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reason).toMatch(/^title=\d\.\d\d$/);
    expect(hits.unconfirmed).toBe(0);
  });

  it('asks Jev about at most 60 pairs per run and defers the rest', async () => {
    const project = await store.createProject('P0419', { content: 'P0419 — Test | Active' });
    for (let i = 0; i < 62; i++) {
      await store.write(`Pair${i}beta sharedterm\nA.`, { parentId: project.id, tags: ['#pair', '#beta'] });
      await store.write(`Pair${i}beta sharedterm notes\nB.`, { parentId: project.id, tags: ['#pair', '#beta'] });
    }
    const fetchMock = stubNoul(0.9);
    const hits = await store.consolidate().findDuplicateCandidates('P0419');
    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(hits.confirmed).toBe(60);
    expect(hits.deferred).toBe(2);
  });

  it('confirm:false enqueues without calling Jev', async () => {
    await seedPair('P0414');
    process.env.JEV_API_KEY = 'test-key';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const hits = await store.consolidate().findDuplicateCandidates('P0414', { confirm: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reason).not.toContain('unconfirmed');
    expect(String(hits[0]!.reason)).not.toMatch(/jev=/);
    const queue = await store.consolidate().getCurationQueue('P0414', 'pending');
    expect(queue[0]!.metadata.jev).toBeUndefined();
  });

  it('runs Jev confirmations with at most 6 requests in flight', async () => {
    const project = await store.createProject('P0415', { content: 'P0415 — Test | Active' });
    for (let i = 0; i < 7; i++) {
      await store.write(`Pair${i}alpha sharedterm\nA.`, {
        parentId: project.id,
        tags: ['#pair', '#alpha'],
      });
      await store.write(`Pair${i}alpha sharedterm notes\nB.`, {
        parentId: project.id,
        tags: ['#pair', '#alpha'],
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    process.env.JEV_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 40));
      inFlight--;
      return new Response(JSON.stringify({ answers: { same: { type: 'noul', noul: 0.91 } } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const hits = await store.consolidate().findDuplicateCandidates('P0415');
    expect(hits).toHaveLength(7);
    expect(hits.confirmed).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });

  it('does not treat version titles that differ only by a digit as duplicates', async () => {
    const project = await store.createProject('P0416', { content: 'P0416 — Test | Active' });
    await store.write('v1.3.7\nRelease A.', { parentId: project.id, tags: ['#release', '#a'] });
    await store.write('v1.3.5\nRelease B.', { parentId: project.id, tags: ['#release', '#b'] });
    const hits = await store.consolidate().findDuplicateCandidates('P0416', { confirm: false });
    expect(hits).toHaveLength(0);
  });
});
