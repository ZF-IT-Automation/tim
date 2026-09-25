// includeKinds is an allow-list in the FTS statement, before LIMIT.
// A post-filter would throw away the page: commits outrank summaries on bm25
// (short, dense hits), so LIMIT 1 with the filter applied afterwards is empty
// and the summary the caller asked for never comes back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, KIND_BATCH, KIND_SUMMARY_ROOT } from '../index.js';

let store: TimStore;

beforeEach(() => {
  store = new TimStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('searchFts includeKinds', () => {
  it('returns only the listed kinds', async () => {
    await store.write('zephyr commit note', { metadata: { kind: 'commit' } });
    await store.write('zephyr plain note', { metadata: { kind: 'note' } });
    await store.write('zephyr batch', { metadata: { kind: KIND_BATCH } });
    await store.write('zephyr rollup', { metadata: { kind: KIND_SUMMARY_ROOT } });

    const hits = await store.searchFts('zephyr', 20, {
      includeKinds: [KIND_BATCH, KIND_SUMMARY_ROOT],
    });

    expect(hits.map(h => h.metadata.kind).sort()).toEqual([KIND_BATCH, KIND_SUMMARY_ROOT].sort());
  });

  it('applies the kind allow-list before LIMIT', async () => {
    for (let i = 0; i < 8; i++) {
      // One token, nothing else: bm25 ranks these above a long summary that
      // merely mentions the word. If the allow-list ran after LIMIT 1, the
      // page would be one of these and the summary would be gone.
      await store.write('zephyr', { title: `noise ${i}`, metadata: { kind: 'commit' } });
    }
    const summary = await store.write(
      'zephyr is one word inside a much longer batch summary about unrelated work that should still be reachable when commits are not asked for',
      { title: 'wanted', metadata: { kind: KIND_BATCH } },
    );

    const top = await store.searchFts('zephyr', 1);
    expect(top).toHaveLength(1);
    expect(top[0]!.metadata.kind).toBe('commit');

    const filtered = await store.searchFts('zephyr', 1, { includeKinds: [KIND_BATCH] });
    expect(filtered.map(h => h.id)).toEqual([summary.id]);
  });
});
