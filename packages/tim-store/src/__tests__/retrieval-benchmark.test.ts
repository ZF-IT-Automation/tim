import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, runBenchmark, type GoldenQuery } from '../store.js';

describe('retrieval benchmark harness', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scores precision@3 and recall@5 for a known golden query', async () => {
    const a = await store.write('How to configure nginx reverse proxy\nSteps for Ubuntu 24.04.', {
      tags: ['#nginx', '#ops', '#config'],
    });
    await store.write('Unrelated topic about Python\nDjango views.', {
      tags: ['#python', '#django'],
    });

    const results = await runBenchmark(store, [{
      query: 'nginx proxy config',
      expectedIds: [a.id],
    } satisfies GoldenQuery]);

    expect(results.length).toBe(1);
    expect(results[0].found).toContain(a.id);
    expect(results[0].precisionAt3).toBeGreaterThanOrEqual(1 / 3);
  });

  it('reports MRR for the first relevant hit', async () => {
    const a = await store.write('Deploy steps\nServer setup.', { tags: ['#deploy'] });
    await store.write('Another thing\nMore content.', { tags: ['#x'] });
    await store.write('Third item\nStuff.', { tags: ['#y'] });

    const results = await runBenchmark(store, [{
      query: 'deploy steps',
      expectedIds: [a.id],
    }]);

    expect(results[0].mrr).toBeGreaterThan(0);
  });
});
