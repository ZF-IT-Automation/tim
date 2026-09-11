import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore, type EmbeddingProvider } from '../index.js';
import { applyRemoteEntry } from '../sync-methods.js';
import { entryTemporallyEligibleAt } from '../temporal.js';

const MODEL = 'all-MiniLM-L6-v2';

function unitVector(dim = 384, bias = 0.1): Float32Array {
  const v = new Float32Array(dim);
  v[0] = bias;
  v[1] = 1 - bias;
  return v;
}

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
    const provider: EmbeddingProvider = {
      modelId: MODEL,
      dimension: 384,
      state: 'enabled',
      embed: async texts => texts.map(() => unitVector()),
    };
    store = new TimStore(path.join(dir, 'test.db'), { embeddingProvider: provider });
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

    store.setVectors(entry.id, unitVector(384, 0.85), MODEL, 384);
    const vector = await store.search({ query: 'Replicated', searchType: 'vector', topK: 10 });
    expect(vector.map(e => e.id)).toContain(entry.id);
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
