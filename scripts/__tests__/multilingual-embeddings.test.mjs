import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { eligible, fuse, joinLabels, meanPool, measure, readRecallEntries, union } from '../multilingual-embeddings.mjs';

const require = createRequire(import.meta.url);
const { TimStore } = require('../../packages/tim-store/dist/index.js');

describe('multilingual embedding evaluation', () => {
  it('includes FTS-retrievable summaries and commits that the current vector index excludes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tim-embedding-eval-'));
    const store = new TimStore(join(dir, 'test.db'), { staging: false });
    try {
      const note = await store.write('Useful note', { title: 'Note' });
      const summary = await store.write('Useful prior finding', { title: 'Summary', metadata: { kind: 'batch-summary' } });
      const commit = await store.write('Useful fix', { title: 'Commit', metadata: { kind: 'commit' } });
      await store.write('Old prompt', { metadata: { kind: 'exchange' } });
      await store.write('Checkpoint', { metadata: { kind: 'checkpoint' } });
      await store.write('Harness content', { metadata: { system_turn: true } });
      const ids = (await readRecallEntries(store)).map(e => e.id);
      expect(new Set(ids)).toEqual(new Set([note.id, summary.id, commit.id]));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps unjudged hits separate from negative labels and deduplicates recall', () => {
    expect(measure(['good', 'good', 'bad', 'new'], { good: true, missing: true, bad: false }, ['bad'])).toEqual({
      returned: 3, totalUseful: 2, useful: 1, useless: 1, unknown: 1, recall: 0.5, onlyVector: ['good'],
    });
    expect(measure(['new'], {}).recall).toBeNull();
  });

  it('reports the full union separately from a fixed-budget fused ranking', () => {
    expect(union(['a', 'b', 'c'], ['d', 'b', 'e'], 2)).toEqual(['a', 'b', 'd']);
    expect(fuse(['a', 'b', 'c'], ['d', 'b', 'e'], 2)).toEqual(['b', 'a']);
  });

  it('excludes future entries and entries from other projects', () => {
    const entry = { createdAt: '2026-09-20T00:00:00Z', scopes: ['P0063'] };
    expect(eligible(entry, { createdAt: '2026-09-21T00:00:00Z', project: 'P0063' })).toBe(true);
    expect(eligible(entry, { createdAt: entry.createdAt, project: 'P0063' })).toBe(false);
    expect(eligible(entry, { createdAt: '2026-09-21T00:00:00Z', project: 'P0076' })).toBe(false);
    expect(eligible(entry, { createdAt: '2026-09-21T00:00:00Z', project: null })).toBe(true);
  });

  it('pools every unmasked token and normalizes each batch item independently', () => {
    const vectors = meanPool(new Float32Array([3, 0, 0, 4, 100, 100, 0, 2, 0, 2, 100, 100]), [2, 3, 2], [[1, 1, 0], [1, 1, 0]]);
    expect(vectors[0][0]).toBeCloseTo(0.6);
    expect(vectors[0][1]).toBeCloseTo(0.8);
    expect([...vectors[1]]).toEqual([0, 1]);
    expect(() => meanPool(new Float32Array([0, 0]), [1, 1, 2], [[1]])).toThrow('Invalid pooled embedding');
  });

  it('resolves shuffled labels through cid, including the set without entry IDs', () => {
    const cases = [{ i: 0, candidates: [{ id: 'a' }, { id: 'b' }] }];
    const inputs = [{ i: 0, candidates: [{ cid: '0:1' }, { cid: '0:0', id: 'a' }] }];
    const outputs = [{ cid: '0:1', helpful: false }, { cid: '0:0', helpful: true }];
    expect(joinLabels(cases, inputs, outputs)[0].labels).toEqual({ a: true, b: false });
    expect(() => joinLabels(cases, [{ i: 0, candidates: [{ cid: '0:0', id: 'wrong' }] }], outputs)).toThrow('Candidate mismatch');
    expect(() => joinLabels(cases, inputs, [...outputs, { cid: '0:0', helpful: false }])).toThrow('Conflicting label');
  });
});
