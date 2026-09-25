import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from 'tim-store';
import { executeTimSearch } from '../tim-search-tool.js';

describe('tim_search omits commit entries unless includeCommits', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('returns only the normal entry by default and both when includeCommits is set', async () => {
    const note = await store.write('zephyr ledger note', {
      title: 'zephyr note',
      metadata: { kind: 'note' },
    });
    const commit = await store.write('zephyr ledger commit', {
      title: 'zephyr commit',
      metadata: { kind: 'commit' },
    });

    const hidden = await executeTimSearch(store, { query: 'zephyr ledger', searchType: 'fts' });
    expect(hidden.results.map(hit => hit.id)).toEqual([note.id]);

    const shown = await executeTimSearch(store, {
      query: 'zephyr ledger',
      searchType: 'fts',
      includeCommits: true,
    });
    expect(shown.results.map(hit => hit.id).sort()).toEqual([note.id, commit.id].sort());
  });
});
