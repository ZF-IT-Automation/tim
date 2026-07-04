import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, titleSimilarity } from '../store.js';

describe('titleSimilarity', () => {
  it('is 1.0 for identical titles up to case and punctuation', () => {
    expect(titleSimilarity('FTS Sanitizer quotes tokens', 'fts sanitizer quotes tokens!')).toBe(1);
  });

  it('scores high overlap above the 0.6 threshold', () => {
    expect(
      titleSimilarity('Reminder-System via Cron-Checker', 'Reminder System Cron Checker Design'),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('SQLite WAL checkpoint', 'Telegram bot pairing')).toBe(0);
  });

  it('handles empty titles', () => {
    expect(titleSimilarity('', 'anything')).toBe(0);
  });
});

describe('TimStore.findSimilar', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a near-duplicate title and scores it', async () => {
    const existing = await store.write('Reminder System via Cron Checker\nDesign notes.', {
      tags: ['#reminder', '#design'],
    });
    await store.write('Telegram bot pairing\nUnrelated.', { tags: ['#telegram', '#bot'] });

    const hits = await store.findSimilar('Reminder System Cron Checker v2');
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(existing.id);
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('scopes to a project label when given', async () => {
    const projA = await store.write('Project A', { metadata: { kind: 'project', label: 'P0001' } });
    const projB = await store.write('Project B', { metadata: { kind: 'project', label: 'P0002' } });
    await store.write('Shared idea title here\nIn A.', {
      parentId: projA.id, tags: ['#idea', '#x'],
    });

    const inB = await store.findSimilar('Shared idea title here', { projectLabel: 'P0002' });
    expect(inB).toEqual([]);
    const inA = await store.findSimilar('Shared idea title here', { projectLabel: 'P0001' });
    expect(inA.length).toBe(1);
    expect(projB.id).toBeTruthy();
  });

  it('returns nothing below the threshold', async () => {
    await store.write('Completely different words\nBody.', { tags: ['#a', '#b'] });
    expect(await store.findSimilar('quantum flux capacitor')).toEqual([]);
  });
});
