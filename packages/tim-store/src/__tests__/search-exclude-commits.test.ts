// Commit rows stay recorded (last-activity) but are recall noise: git log
// already has them. Default search drops metadata.kind "commit" before LIMIT.
// includeCommits brings them back beside a normal hit on the same query.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../index.js';

let store: TimStore;

beforeEach(() => {
  store = new TimStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('search omits commit entries unless asked', () => {
  it('returns only the normal entry by default and both when includeCommits is set', async () => {
    const note = await store.write('zephyr ledger note', {
      title: 'zephyr note',
      metadata: { kind: 'note' },
    });
    const commit = await store.write('zephyr ledger commit', {
      title: 'zephyr commit',
      metadata: { kind: 'commit' },
    });

    const hidden = await store.search({
      query: 'zephyr ledger',
      topK: 10,
      searchType: 'fts',
    });
    expect(hidden.map(hit => hit.id)).toEqual([note.id]);

    const shown = await store.search({
      query: 'zephyr ledger',
      topK: 10,
      searchType: 'fts',
      includeCommits: true,
    });
    expect(shown.map(hit => hit.id).sort()).toEqual([note.id, commit.id].sort());

    const ftsHidden = await store.searchFts('zephyr ledger', 10);
    expect(ftsHidden.map(hit => hit.id)).toEqual([note.id]);

    const ftsShown = await store.searchFts('zephyr ledger', 10, { includeCommits: true });
    expect(ftsShown.map(hit => hit.id).sort()).toEqual([note.id, commit.id].sort());
  });

  it('still drops commits when the caller already excludes another kind', async () => {
    await store.write('zephyr ledger exchange', { metadata: { kind: 'exchange' } });
    await store.write('zephyr ledger commit', { metadata: { kind: 'commit' } });
    const note = await store.write('zephyr ledger note', { metadata: { kind: 'note' } });

    const hits = await store.searchFts('zephyr ledger', 10, { excludeKinds: ['exchange'] });
    expect(hits.map(hit => hit.id)).toEqual([note.id]);
  });

  it('returns commits when includeKinds names commit', async () => {
    const commit = await store.write('zephyr ledger commit', { metadata: { kind: 'commit' } });
    await store.write('zephyr ledger note', { metadata: { kind: 'note' } });

    const hits = await store.searchFts('zephyr ledger', 10, { includeKinds: ['commit'] });
    expect(hits.map(hit => hit.id)).toEqual([commit.id]);
  });
});
