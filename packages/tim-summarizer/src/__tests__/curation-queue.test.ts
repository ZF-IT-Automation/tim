import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimStore } from 'tim-store';
import { processCurationQueue } from '../summarize.js';
import * as generate from '../generate-summary.js';

describe('processCurationQueue', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    store.close();
  });

  it('merges duplicate pair and marks source irrelevant', async () => {
    const project = await store.createProject('P0400', { content: 'P0400 — Merge | Active' });
    const keep = await store.write('Keep me\nOriginal.', {
      parentId: project.id,
      tags: ['#keep', '#mem'],
    });
    const drop = await store.write('Drop me\nDuplicate.', {
      parentId: project.id,
      tags: ['#drop', '#mem'],
    });

    const mgr = store.consolidate();
    await mgr.enqueue('P0400', 'duplicate', {
      consolidation: 'duplicate',
      status: 'pending',
      pair: [keep.id, drop.id] as [string, string],
      score: 0.9,
      reason: 'test',
    });

    vi.spyOn(generate, 'generateSummary').mockResolvedValue('Merged body\nTAGS: #merged #mem');

    const n = await processCurationQueue(store, 'P0400');
    expect(n).toBe(1);

    const kept = await store.read(keep.id);
    const dropped = await store.read(drop.id, { showIrrelevant: true });
    expect(kept!.content).toContain('Merged body');
    expect(dropped!.irrelevant).toBe(true);

    const queue = await mgr.getCurationQueue('P0400', 'done');
    expect(queue).toHaveLength(1);
  });

  it('rejects decay when LLM says KEEP', async () => {
    const project = await store.createProject('P0401', { content: 'P0401 — Decay | Active' });
    const target = await store.write('Maybe stale\nContent.', {
      parentId: project.id,
      tags: ['#maybe', '#stale'],
    });

    const mgr = store.consolidate();
    await mgr.enqueue('P0401', 'decay', {
      consolidation: 'decay',
      status: 'pending',
      target: target.id,
      reason: 'test decay',
    });

    vi.spyOn(generate, 'generateSummary').mockResolvedValue('KEEP — still relevant');

    const n = await processCurationQueue(store, 'P0401');
    expect(n).toBe(1);
    expect((await store.read(target.id))!.irrelevant).toBe(false);

    const rejected = await mgr.getCurationQueue('P0401', 'rejected');
    expect(rejected).toHaveLength(1);
  });
});
