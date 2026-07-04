import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('usage-weighted search ranking', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
    delete process.env.TIM_USAGE_RANKING;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.TIM_USAGE_RANKING;
  });

  /**
   * strongFts mentions the query term repeatedly (better bm25 rank);
   * weakFts mentions it once but is heavily referenced. The boost
   * (2·log2(1+3) = 4 positions) must lift weakFts above strongFts.
   */
  async function fixture() {
    const strongFts = await store.write(
      'Deployment checklist deployment steps\nDeployment deployment deployment.',
      { tags: ['#deploy', '#ops'] },
    );
    const weakFts = await store.write(
      'Server notes\nOne mention of deployment here.',
      { tags: ['#deploy', '#ops'] },
    );
    for (const sid of ['s1', 's2', 's3']) {
      store.recordRead([weakFts.id], sid);
      store.markReferenced([weakFts.id], sid);
    }
    return { strongFts, weakFts };
  }

  it('boosts frequently-referenced entries above better FTS matches', async () => {
    const { strongFts, weakFts } = await fixture();
    const results = await store.search({ query: 'deployment', topK: 5 });
    const ids = results.map(e => e.id);
    expect(ids.indexOf(weakFts.id)).toBeLessThan(ids.indexOf(strongFts.id));
  });

  it('TIM_USAGE_RANKING=0 restores pure FTS order', async () => {
    const { strongFts, weakFts } = await fixture();
    process.env.TIM_USAGE_RANKING = '0';
    const results = await store.search({ query: 'deployment', topK: 5 });
    const ids = results.map(e => e.id);
    expect(ids.indexOf(strongFts.id)).toBeLessThan(ids.indexOf(weakFts.id));
  });

  it('still honors topK', async () => {
    await fixture();
    const results = await store.search({ query: 'deployment', topK: 1 });
    expect(results.length).toBe(1);
  });
});
