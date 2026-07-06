import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, titleSimilarity } from '../index.js';

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
