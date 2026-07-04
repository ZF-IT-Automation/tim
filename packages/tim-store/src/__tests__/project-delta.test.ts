import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('project delta', () => {
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

  it('classifies created / updated / deleted relative to the cutoff', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    const before1 = await store.write('Old note\nUnchanged.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });
    const before2 = await store.write('Will change\nOriginal.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });
    const before3 = await store.write('Will die\nBody.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });

    await sleep(10);
    const cutoff = new Date().toISOString();
    await sleep(10);

    const created = await store.write('New note\nFresh.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });
    await store.update(before2.id, { content: 'Will change\nEdited.' });
    await store.delete(before3.id, true); // hard = tombstone

    const delta = await store.getChangedSince(proj.id, cutoff);
    expect(delta.created.map(e => e.id)).toEqual([created.id]);
    expect(delta.updated.map(e => e.id)).toEqual([before2.id]);
    expect(delta.deleted.map(e => e.id)).toEqual([before3.id]);
    // Untouched entry and the project root never appear.
    const all = [...delta.created, ...delta.updated, ...delta.deleted].map(e => e.id);
    expect(all).not.toContain(before1.id);
    expect(all).not.toContain(proj.id);
  });

  it('only sees the given project subtree', async () => {
    const projA = await store.write('A', { metadata: { kind: 'project', label: 'P0001' } });
    const projB = await store.write('B', { metadata: { kind: 'project', label: 'P0002' } });
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    await store.write('In B\nBody.', { parentId: projB.id, tags: ['#a', '#b'] });

    const delta = await store.getChangedSince(projA.id, cutoff);
    expect(delta.created).toEqual([]);
    expect(delta.updated).toEqual([]);
    expect(delta.deleted).toEqual([]);
  });

  it('getPreviousSession finds the newest session excluding the current one', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    const s1 = await store.write('Session one', {
      parentId: proj.id, metadata: { kind: 'session' },
    });
    await sleep(10);
    const s2 = await store.write('Session two', {
      parentId: proj.id, metadata: { kind: 'session' },
    });

    expect((await store.getPreviousSession(proj.id, s2.id))?.id).toBe(s1.id);
    expect((await store.getPreviousSession(proj.id))?.id).toBe(s2.id);
  });

  it('getPreviousSession returns null when there are no sessions', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    expect(await store.getPreviousSession(proj.id)).toBeNull();
  });
});
