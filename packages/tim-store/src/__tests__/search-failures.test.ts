import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('TimStore.searchFailures', () => {
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

  it('returns only error/learning entries matching the query', async () => {
    const err = await store.write(
      'rmapi upload fails with HTTP 400\nBroken since 2025, use sync fox v3 API.',
      { tags: ['#remarkable', '#upload'], metadata: { kind: 'error' } },
    );
    const lesson = await store.write(
      'Lesson: rmapi put is dead\nAlways use the direct upload workaround.',
      { tags: ['#remarkable', '#upload'], metadata: { kind: 'learning' } },
    );
    await store.write(
      'rmapi feature idea upload queue\nNot a failure.',
      { tags: ['#remarkable', '#idea'], metadata: { kind: 'idea' } },
    );

    const hits = await store.searchFailures('rmapi upload');
    const ids = hits.map(e => e.id);
    expect(ids).toContain(err.id);
    expect(ids).toContain(lesson.id);
    expect(ids.length).toBe(2);
  });

  it('scopes to a project when given', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    const inProj = await store.write(
      'Deploy failure on strato\nsystemd unit crashed.',
      { parentId: proj.id, tags: ['#deploy', '#fail'], metadata: { kind: 'error' } },
    );
    await store.write(
      'Deploy failure elsewhere\nDifferent project context.',
      { tags: ['#deploy', '#fail'], metadata: { kind: 'error' } },
    );

    const hits = await store.searchFailures('deploy failure', { projectLabel: 'P0001' });
    expect(hits.map(e => e.id)).toEqual([inProj.id]);
  });

  it('tokenizes German umlauts without splitting letters', async () => {
    const err = await store.write(
      'Überweisung schlägt fehl\nSEPA-Lastschrift bricht mit Timeout ab.',
      { tags: ['#banking', '#sepa'], metadata: { kind: 'error' } },
    );

    const hits = await store.searchFailures('Überweisung ausführen');
    expect(hits.map(e => e.id)).toContain(err.id);
  });

  it('returns empty for a query with no failure matches', async () => {
    await store.write('Happy note\nAll good.', { tags: ['#a', '#b'] });
    expect(await store.searchFailures('happy note')).toEqual([]);
  });

  it('keeps content words office and plants in guard queries', async () => {
    const err = await store.write(
      'office plants humidity sensor fails\nSensors in the office plant area misread.',
      {
        tags: ['#plants', '#office'],
        metadata: { kind: 'error', title: 'office plants humidity sensor fails' },
      },
    );

    const hits = await store.searchFailures('water the office plants');
    expect(hits.map(e => e.id)).toContain(err.id);
  });
});
