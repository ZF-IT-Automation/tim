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

  it('ranks the given project first and keeps other projects', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    const elsewhere = await store.write(
      'Deploy failure elsewhere\nDifferent project context.',
      { tags: ['#deploy', '#fail'], metadata: { kind: 'error' } },
    );
    const inProj = await store.write(
      'Deploy failure on strato\nsystemd unit crashed.',
      { parentId: proj.id, tags: ['#deploy', '#fail'], metadata: { kind: 'error' } },
    );

    const hits = await store.searchFailures('deploy failure', { projectLabel: 'P0001' });
    expect(hits.map(e => e.id)).toEqual([inProj.id, elsewhere.id]);
  });

  it('needs two query terms when a project is given, in that project too', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    await store.write(
      'Strato disk quota\nCheck df first.',
      { parentId: proj.id, tags: ['#ops'], metadata: { kind: 'learning' } },
    );
    const inProj = await store.write(
      'Strato deploy wipes the cache\nWarm it after.',
      { parentId: proj.id, tags: ['#ops'], metadata: { kind: 'learning' } },
    );
    await store.write(
      'Vercel deploy needs env vars\nSet them in the dashboard.',
      { tags: ['#ops'], metadata: { kind: 'learning' } },
    );
    const strong = await store.write(
      'Strato deploy restarts systemd unit\nRun daemon-reload first.',
      { tags: ['#ops'], metadata: { kind: 'learning' } },
    );

    const hits = await store.searchFailures('deploy to strato', { projectLabel: 'P0001' });
    expect(hits.map(e => e.id)).toEqual([inProj.id, strong.id]);
  });

  it('reaches learnings under an archived project', async () => {
    await store.write('Home', { metadata: { kind: 'project', label: 'P0001' } });
    const archived = await store.write('Old', {
      metadata: { kind: 'project', label: 'P0072', status: 'archived' },
    });
    const lesson = await store.write(
      'tmux spawn without watcher loses the result\nAlways start runs wait.',
      { parentId: archived.id, tags: ['#tmux'], metadata: { kind: 'learning' } },
    );

    const hits = await store.searchFailures('spawn a tmux worker', { projectLabel: 'P0001' });
    expect(hits.map(e => e.id)).toEqual([lesson.id]);
  });

  it('leaves out learnings under a subtree marked secret after they were written', async () => {
    const vault = await store.write('Vault', { metadata: { kind: 'project', label: 'P0002' } });
    await store.write('Vault deploy key rotation\nRotate before deploy.', {
      parentId: vault.id,
      metadata: { kind: 'learning' },
    });
    await store.update(vault.id, { metadata: { kind: 'project', label: 'P0002', secret: true } });

    expect(await store.searchFailures('vault deploy')).toEqual([]);
  });

  it('counts kind lesson, type learning and #lesson tags as failure knowledge', async () => {
    const byKind = await store.write('Quota lesson one\nx', { metadata: { kind: 'lesson' } });
    const byType = await store.write('Quota lesson two\nx', { metadata: { type: 'learning' } });
    const byTag = await store.write('Quota lesson three\nx', { tags: ['#lesson'] });
    await store.write('Quota note\nx', { tags: ['#note'] });

    const ids = (await store.searchFailures('quota')).map(e => e.id);
    expect(ids.sort()).toEqual([byKind.id, byType.id, byTag.id].sort());
  });

  it('ranks #universal learnings above other projects', async () => {
    await store.write('Home', { metadata: { kind: 'project', label: 'P0001' } });
    const plain = await store.write(
      'Branch push rejected\nFetch first.',
      { tags: ['#git'], metadata: { kind: 'learning' } },
    );
    const universal = await store.write(
      'Never push secrets to a branch\nScan the diff.',
      { tags: ['#git', '#universal'], metadata: { kind: 'learning' } },
    );
    await store.write(
      'Never push secrets\nOne term is not enough, #universal or not.',
      { tags: ['#git', '#universal'], metadata: { kind: 'learning' } },
    );

    const hits = await store.searchFailures('push the branch', { projectLabel: 'P0001' });
    expect(hits.map(e => e.id)).toEqual([universal.id, plain.id]);
  });

  it('finds failures that rank below unrelated FTS hits', async () => {
    for (let i = 0; i < 60; i++) await store.write(`Deploy note ${i}\ndeploy deploy deploy`);
    const lesson = await store.write('Deploy lesson\nPin the node version.', {
      metadata: { kind: 'learning' },
    });

    expect((await store.searchFailures('deploy')).map(e => e.id)).toEqual([lesson.id]);
  });

  it('matches German action verbs against English and German learnings', async () => {
    await store.write('Home', { metadata: { kind: 'project', label: 'P0001' } });
    const english = await store.write(
      'git push to a protected branch is rejected\nOpen a PR instead.',
      { metadata: { kind: 'learning' } },
    );
    const german = await store.write(
      'Alte Clones erst löschen, wenn nichts ungepusht ist\nVorher git status.',
      { metadata: { kind: 'learning' } },
    );

    expect((await store.searchFailures('Pushe den Branch bitte', { projectLabel: 'P0001' }))
      .map(e => e.id)).toEqual([english.id]);
    expect((await store.searchFailures('Lösche die alten Clones', { projectLabel: 'P0001' }))
      .map(e => e.id)).toEqual([german.id]);
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
