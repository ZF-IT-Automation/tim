import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('touchVerified + stale health metric', () => {
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

  it('touchVerified stamps metadata.verified_at and stages an upsert', async () => {
    const entry = await store.write('Fact\nPort is 3100.', { tags: ['#api', '#infra'] });
    const before = await store.getStagingCursor();

    const result = await store.touchVerified([entry.id, 'nonexistent-id']);
    expect(result.verified).toEqual([entry.id]);
    expect(result.missing).toEqual(['nonexistent-id']);

    const read = await store.read(entry.id);
    expect(typeof read!.metadata.verified_at).toBe('string');
    // Content untouched, verification synced via staging.
    expect(read!.content).toBe('Port is 3100.');
    expect(await store.getStagingCursor()).toBeGreaterThan(before);
  });

  it('health counts stale knowledge entries but never schema entries', async () => {
    const old = new Date(Date.now() - 200 * 86400_000).toISOString();
    const fresh = await store.write('Fresh fact\nStill true.', { tags: ['#a', '#b'] });

    const staleKnowledge = await store.write('Old fact\nMaybe rotten.', { tags: ['#a', '#b'] });
    const staleSession = await store.write('Session x', { metadata: { kind: 'session' } });
    // Backdate directly — tests own their fixtures; production never does this.
    const db = store.getDb();
    db.prepare('UPDATE entries SET created_at = ?, updated_at = ? WHERE id IN (?, ?)')
      .run(old, old, staleKnowledge.id, staleSession.id);

    const health = await store.health();
    expect(health.staleEntries).toBe(1); // only the knowledge entry

    // Verifying clears staleness.
    await store.touchVerified([staleKnowledge.id]);
    expect((await store.health()).staleEntries).toBe(0);
    expect((await store.read(fresh.id))).toBeTruthy();
  });
});
