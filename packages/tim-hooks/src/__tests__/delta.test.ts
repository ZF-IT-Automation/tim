import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import { getDeltaBriefing } from '../delta.js';

describe('getDeltaBriefing', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-delta-hook-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns delta block when entries changed since cutoff', async () => {
    const proj = await store.createProject('P0001', { content: 'Proj' });
    const fresh = await store.write('Fresh task', {
      parentId: proj.id,
      metadata: { kind: 'task' },
      tags: ['#a', '#b'],
    });

    vi.spyOn(store, 'getPreviousSession').mockResolvedValue({
      id: 'prev-session',
      title: 'Prev',
      content: '',
      parentId: proj.id,
      contentType: 'text',
      depth: 2,
      confidence: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
      decayRate: 0,
      visibility: 1,
      tags: [],
      irrelevant: false,
      favorite: false,
      tombstonedAt: null,
      metadata: { kind: 'session' },
    });

    vi.spyOn(store, 'getChangedSince').mockResolvedValue({
      created: [fresh],
      updated: [],
      deleted: [],
    });

    const block = await getDeltaBriefing(store, 'P0001', { sessionId: 'current' });
    expect(block).toContain('[Since last session]');
    expect(block).toContain('1 new');
    expect(block).toMatch(/Fresh task/);
  });

  it('returns null when nothing changed', async () => {
    await store.createProject('P0002', { content: 'Proj' });

    vi.spyOn(store, 'getPreviousSession').mockResolvedValue(null);
    vi.spyOn(store, 'getChangedSince').mockResolvedValue({
      created: [],
      updated: [],
      deleted: [],
    });

    const block = await getDeltaBriefing(store, 'P0002');
    expect(block).toBeNull();
  });

  it('skips on timeout', async () => {
    const proj = await store.createProject('P0003', { content: 'Proj' });
    vi.spyOn(store, 'getChangedSince').mockImplementation(
      () => new Promise(() => {}),
    );

    const block = await getDeltaBriefing(store, proj.id, { timeoutMs: 50 });
    expect(block).toBeNull();
  });
});
