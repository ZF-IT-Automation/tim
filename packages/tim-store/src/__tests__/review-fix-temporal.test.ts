import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from '../index.js';
import { applyRemoteEntry } from '../sync-methods.js';
import { entryTemporallyEligibleAt } from '../temporal.js';

function peerPayload(
  entry: { id: string; title: string; content: string; depth: number; createdAt: string; accessedAt: string; parentId: string | null },
  metadataRaw: string,
) {
  return JSON.stringify({
    id: entry.id,
    parent_id: entry.parentId,
    title: entry.title,
    content: entry.content,
    content_type: 'text',
    depth: entry.depth,
    confidence: 1,
    created_at: entry.createdAt,
    accessed_at: entry.accessedAt,
    decay_rate: 0,
    visibility: 1,
    tags: JSON.stringify(['#decision', '#note']),
    irrelevant: 0,
    favorite: 0,
    tombstoned_at: null,
    metadata: {},
    metadata_raw: metadataRaw,
  });
}

describe('review-fix temporal/search/recovery', () => {
  let dir: string;
  let store: TimStore;
  let sectionId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-review-fix-temporal-'));
    store = new TimStore(path.join(dir, 'test.db'));
    const project = await store.createProject('P3700', { content: 'Review fix', memoryOnly: true });
    const section = await store.write('Decisions', {
      parentId: project.id,
      metadata: { kind: 'section' },
      tags: ['#section', '#schema'],
    });
    sectionId = section.id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function writeDecision(title: string, body: string, metadata: Record<string, unknown> = {}) {
    return store.write(`${title}\n${body}`, {
      parentId: sectionId,
      tags: ['#decision', '#note'],
      metadata,
    });
  }

  it('F1: scalar metadata.temporal does not break search', async () => {
    const entry = await writeDecision('Malformed peer', 'Body text');
    applyRemoteEntry(
      store.getDb(),
      peerPayload(entry, JSON.stringify({ temporal: 'broken' })),
      Date.now() + 10_000,
      'peer-device',
      false,
    );

    const fts = await store.search({ query: 'Body', searchType: 'fts', topK: 10 });
    expect(fts.map(e => e.id)).toContain(entry.id);
  });

  it('F2: peer row with microsecond timestamps stays searchable as legacy current', async () => {
    const entry = await writeDecision('Peer decision', 'Replicated from another device');
    applyRemoteEntry(
      store.getDb(),
      peerPayload(entry, JSON.stringify({
        temporal: {
          validFrom: '2020-01-01T00:00:00.123456Z',
          validUntil: '2099-01-01T00:00:00.123456Z',
        },
      })),
      Date.now() + 10_000,
      'peer-device',
      false,
    );

    const stored = await store.read(entry.id);
    expect(entryTemporallyEligibleAt(stored!, new Date())).toBe(true);

    const fts = await store.search({ query: 'Replicated', searchType: 'fts', topK: 10 });
    expect(fts.map(e => e.id)).toContain(entry.id);
  });

  it('F3: tag-only lookup honors temporal eligibility and asOf', async () => {
    const oldDecision = await writeDecision('Old policy', 'Deploy on Fridays');
    const newDecision = await writeDecision('New policy', 'Never deploy on Fridays');
    await store.link(newDecision.id, oldDecision.id, 'supersedes', 1, {
      effectiveAt: '2020-01-01T00:00:00Z',
    });

    const byTag = await store.searchByTag('#decision', 10);
    expect(byTag.map(e => e.id)).not.toContain(oldDecision.id);

    const historical = await store.searchByTag('#decision', 10, undefined, {
      asOf: '2019-01-01T00:00:00Z',
    });
    expect(historical.map(e => e.id)).toContain(oldDecision.id);
    expect(historical.map(e => e.id)).not.toContain(newDecision.id);

    await expect(store.searchByTag('#decision', 10, undefined, { asOf: 'not-a-timestamp' }))
      .rejects.toThrow(/Invalid asOf/);
  });

  it('F4: mistaken supersedes link can be recovered via unlink with snapshot', async () => {
    const oldDecision = await writeDecision('Old policy', 'Deploy on Fridays');
    const wrongTarget = await writeDecision('Unrelated note', 'Deploy on Fridays too');
    const edge = await store.link(wrongTarget.id, oldDecision.id, 'supersedes', 1, {
      effectiveAt: '2020-01-01T00:00:00Z',
    });

    await store.unlink(edge.id);

    const stored = (await store.read(oldDecision.id))!;
    expect((stored.metadata.temporal as Record<string, unknown> | undefined)?.supersededAt).toBeUndefined();
    expect(entryTemporallyEligibleAt(stored, new Date())).toBe(true);

    const hits = await store.search({ query: 'Fridays', searchType: 'fts', topK: 10 });
    expect(hits.map(e => e.id)).toContain(oldDecision.id);
  });

  it('F4: old edge without snapshot requires explicit targetValidity', async () => {
    const oldDecision = await writeDecision('Old policy', 'Deploy on Fridays');
    const wrongTarget = await writeDecision('Unrelated note', 'Deploy on Fridays too');
    const edge = await store.link(wrongTarget.id, oldDecision.id, 'supersedes', 1, {
      effectiveAt: '2020-01-01T00:00:00Z',
    });

    store.getDb().prepare(`
      UPDATE edges SET metadata = json_set(metadata, '$.priorTarget', NULL, '$.priorSource', NULL)
      WHERE id = ?
    `).run(edge.id);

    await expect(store.unlink(edge.id)).rejects.toThrow(/prior validity snapshot/);
    await store.unlink(edge.id, { targetValidity: {} });

    const stored = (await store.read(oldDecision.id))!;
    expect(entryTemporallyEligibleAt(stored, new Date())).toBe(true);
  });

  it('F4: normal non-supersedes unlink remains compatible', async () => {
    const a = await writeDecision('A', 'Body A');
    const b = await writeDecision('B', 'Body B');
    const edge = await store.link(a.id, b.id, 'relates');
    await store.unlink(edge.id);
    expect((await store.getEdges(a.id, 'outgoing')).filter(e => e.id === edge.id)).toHaveLength(0);
  });

  it('rejects explicit empty asOf', async () => {
    await expect(store.searchByTag('#decision', 10, undefined, { asOf: '' }))
      .rejects.toThrow(/Invalid asOf/);
  });

  it('explicitly discards an unmanaged imported edge without changing entry metadata', async () => {
    const target = await writeDecision('Old', 'Body');
    const source = await writeDecision('New', 'Body');
    const db = store.getDb();
    db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
      VALUES ('imported-edge', ?, ?, 'supersedes', 1, '{}', ?)`).run(source.id, target.id, new Date().toISOString());
    const before = db.prepare('SELECT * FROM entries ORDER BY id').all();
    await expect(store.unlink('imported-edge')).rejects.toThrow(/effectiveAt/);
    await store.unlink('imported-edge', { discardUnmanaged: true });
    expect(db.prepare('SELECT * FROM entries ORDER BY id').all()).toEqual(before);
    expect(db.prepare("SELECT id FROM edges WHERE id = 'imported-edge'").get()).toBeUndefined();
  });

  it('refuses discarding a real supersession with managed state', async () => {
    const target = await writeDecision('Old', 'Body');
    const source = await writeDecision('New', 'Body');
    const edge = await store.link(source.id, target.id, 'supersedes', 1, { effectiveAt: '2020-01-01T00:00:00Z' });
    await expect(store.unlink(edge.id, { discardUnmanaged: true })).rejects.toThrow(/managed temporal state/);
    expect((await store.getEdges(source.id)).map(e => e.id)).toContain(edge.id);
  });

  it('preserves source validity when undoing a legacy edge with unknown history', async () => {
    const target = await writeDecision('Old', 'Body');
    const source = await writeDecision('New', 'Body');
    const edge = await store.link(source.id, target.id, 'supersedes', 1, {
      effectiveAt: '2020-01-01T00:00:00Z',
    });
    store.getDb().prepare("UPDATE edges SET metadata = json_remove(metadata, '$.priorTarget', '$.priorSource') WHERE id = ?").run(edge.id);
    const before = (await store.read(source.id))!.metadata;
    await store.unlink(edge.id, { targetValidity: {} });
    expect((await store.read(source.id))!.metadata).toEqual(before);
  });

  it.each(['validFrom', 'validUntil', 'snapshot', 'dependent'])('rejects conflicting %s undo without writes', async (conflict) => {
    const target = await writeDecision('Old', 'Body');
    const source = await writeDecision('New', 'Body');
    const edge = await store.link(source.id, target.id, 'supersedes', 1, {
      effectiveAt: '2020-01-01T00:00:00Z',
    });
    if (conflict === 'snapshot') {
      store.getDb().prepare("UPDATE edges SET metadata = json_set(metadata, '$.priorTarget.validUntil', 'yesterday') WHERE id = ?").run(edge.id);
    } else if (conflict === 'dependent') {
      const newer = await writeDecision('Newest', 'Body');
      await store.link(newer.id, source.id, 'supersedes', 1, { effectiveAt: '2021-01-01T00:00:00Z' });
    } else {
      const value = conflict === 'validFrom' ? '2019-01-01T00:00:00.000Z' : '2020-02-01T00:00:00.000Z';
      store.getDb().prepare('UPDATE entries SET metadata = json_set(metadata, ?, ?) WHERE id = ?')
        .run(`$.temporal.${conflict}`, value, target.id);
    }
    const snapshot = () => ({
      entries: store.getDb().prepare('SELECT * FROM entries ORDER BY id').all(),
      edges: store.getDb().prepare('SELECT * FROM edges ORDER BY id').all(),
      staging: store.getDb().prepare('SELECT * FROM staging').all(),
    });
    const before = snapshot();
    await expect(store.unlink(edge.id)).rejects.toThrow(/supersedes undo/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects duplicate supersedes edges for the same pair', async () => {
    const oldDecision = await writeDecision('Old', 'Body');
    const newDecision = await writeDecision('New', 'Body');
    await store.link(newDecision.id, oldDecision.id, 'supersedes', 1, {
      effectiveAt: '2020-01-01T00:00:00Z',
    });
    await expect(store.link(newDecision.id, oldDecision.id, 'supersedes', 1, {
      effectiveAt: '2021-01-01T00:00:00Z',
    })).rejects.toThrow(/already exists/);
  });
});
