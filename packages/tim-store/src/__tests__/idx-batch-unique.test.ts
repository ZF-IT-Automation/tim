import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';

let store: TimStore;

beforeEach(() => { store = new TimStore(':memory:'); });
afterEach(() => { store.close(); });

describe('idx_batch_unique', () => {
  it('preserves latest batch-summary on same-slot sync collision', async () => {
    const parent = await store.write('Parent', { id: 'parent-1' });

    const local = await store.write('Local summary', {
      parentId: parent.id,
      metadata: { kind: 'batch-summary', batch_index: 0, seq_from: 1, seq_to: 10 },
    });
    await store.update(local.id, {
      metadata: { ...local.metadata, updated_at: '2025-01-01T00:00:00.000Z' },
    });

    const store2 = new TimStore(':memory:');
    try {
      const staging = [{
        key: 'remote-id',
        entityType: 'entry' as const,
        operation: 'upsert' as const,
        payload: JSON.stringify({
          id: 'remote-id',
          parent_id: parent.id,
          title: 'Remote summary',
          content: 'Remote content',
          content_type: 'text',
          depth: 2,
          confidence: 1,
          created_at: '2025-01-01T00:00:00.000Z',
          accessed_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2024-12-31T00:00:00.000Z',
          decay_rate: 0,
          visibility: 1,
          tags: '[]',
          irrelevant: 0,
          tombstoned_at: null,
          metadata: JSON.stringify({ kind: 'batch-summary', batch_index: 0, seq_from: 1, seq_to: 5 }),
        }),
        lwwTimestamp: Date.parse('2024-12-31T00:00:00.000Z'),
        lwwDevice: 'remote',
        lwwConfidence: 1,
        acked: false,
      }];
      await store.applyStaging(staging);

      const localStill = await store.read(local.id);
      expect(localStill).not.toBeNull();
      expect(localStill!.title).toBe('Local summary');

      const remoteGone = await store.read('remote-id');
      expect(remoteGone).toBeNull();
    } finally {
      store2.close();
    }
  });

  it('allows re-summarization after soft-delete of batch-summary', async () => {
    const parent = await store.write('Parent', { id: 'parent-2' });

    const bs = await store.write('Batch summary', {
      parentId: parent.id,
      metadata: { kind: 'batch-summary', batch_index: 1, seq_from: 1, seq_to: 10 },
    });

    await store.update(bs.id, { irrelevant: true });

    const reSummary = await store.write('Re-summarized', {
      parentId: parent.id,
      metadata: { kind: 'batch-summary', batch_index: 1, seq_from: 1, seq_to: 15 },
    });
    expect(reSummary.id).toBeTruthy();

    const oldRead = await store.read(bs.id, { showIrrelevant: true });
    expect(oldRead!.irrelevant).toBe(true);
    const newRead = await store.read(reSummary.id);
    expect(newRead!.irrelevant).toBe(false);
  });

  it('allows renaming a live batch-summary entry', async () => {
    const parent = await store.write('Parent', { id: 'parent-3' });

    const bs = await store.write('Batch summary', {
      id: 'RENAME-OLD',
      parentId: parent.id,
      metadata: { kind: 'batch-summary', batch_index: 2, seq_from: 1, seq_to: 5 },
    });

    const renamed = store.curate().renameEntry('RENAME-OLD', 'RENAME-NEW');
    expect(renamed.id).toBe('RENAME-NEW');
    expect(renamed.metadata.kind).toBe('batch-summary');
    expect(renamed.metadata.batch_index).toBe(2);

    expect(await store.read('RENAME-OLD')).toBeNull();
  });
});
