import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TenantRegistry } from '../tenant-registry.js';
import { createFile, pushBlobs, pullBlobs } from '../storage.js';

describe('storage append-only sync propagation', () => {
  let tmp: string;
  let registry: TenantRegistry;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-prop-'));
    registry = new TenantRegistry(tmp);
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('device B sees updates after device A modifies an existing blob', () => {
    const tenant = registry.register('free');
    createFile(registry, tenant.id, 'f1', 'salt');

    const t1 = '2026-07-07T10:00:00.000Z';
    pushBlobs(registry, tenant.id, 'free', 'f1', 'key-a1', [{
      proposed_id: 'entry-1',
      data: 'v1',
      device_id: 'device-a',
      updated_at: t1,
    }]);

    const pull1 = pullBlobs(registry, tenant.id, 'f1');
    expect('error' in pull1).toBe(false);
    if ('error' in pull1) return;
    expect(pull1.blobs).toHaveLength(1);
    expect(pull1.has_more).toBe(false);

    const t2 = '2026-07-07T11:00:00.000Z';
    pushBlobs(registry, tenant.id, 'free', 'f1', 'key-a2', [{
      proposed_id: 'entry-1',
      data: 'v2-updated',
      device_id: 'device-a',
      updated_at: t2,
    }]);

    const pull2 = pullBlobs(registry, tenant.id, 'f1', pull1.next_cursor);
    expect('error' in pull2).toBe(false);
    if ('error' in pull2) return;
    expect(pull2.blobs).toHaveLength(1);
    expect((pull2.blobs[0] as { data: string }).data).toBe('v2-updated');
  });

  it('pull paginates with has_more and timestamp cursor', () => {
    const tenant = registry.register('free');
    createFile(registry, tenant.id, 'f1', 'salt');

    const blobs = Array.from({ length: 3 }, (_, i) => ({
      proposed_id: `p${i}`,
      data: `d${i}`,
      device_id: 'd1',
      updated_at: `2026-07-07T10:00:0${i}.000Z`,
    }));
    pushBlobs(registry, tenant.id, 'free', 'f1', 'key-page', blobs);

    const page1 = pullBlobs(registry, tenant.id, 'f1', undefined, 2);
    expect('error' in page1).toBe(false);
    if ('error' in page1) return;
    expect(page1.blobs).toHaveLength(2);
    expect(page1.has_more).toBe(true);

    const page2 = pullBlobs(registry, tenant.id, 'f1', page1.next_cursor, 2);
    expect('error' in page2).toBe(false);
    if ('error' in page2) return;
    expect(page2.blobs).toHaveLength(1);
    expect(page2.has_more).toBe(false);
  });

  it('delivers blobs from a device with a lagging clock (updated_at older than cursor)', () => {
    const tenant = registry.register('free');
    createFile(registry, tenant.id, 'f1', 'salt');

    // Device A (correct clock) pushes; device B pulls and advances its cursor.
    pushBlobs(registry, tenant.id, 'free', 'f1', 'key-fast', [{
      proposed_id: 'from-a',
      data: 'a1',
      device_id: 'device-a',
      updated_at: '2026-07-07T12:00:00.000Z',
    }]);
    const pull1 = pullBlobs(registry, tenant.id, 'f1');
    if ('error' in pull1) throw new Error('unexpected');

    // Device C's clock is 5 minutes behind — its blob timestamps sort
    // before B's cursor, but it must still be delivered.
    pushBlobs(registry, tenant.id, 'free', 'f1', 'key-slow', [{
      proposed_id: 'from-c',
      data: 'c1',
      device_id: 'device-c',
      updated_at: '2026-07-07T11:55:00.000Z',
    }]);
    const pull2 = pullBlobs(registry, tenant.id, 'f1', pull1.next_cursor);
    if ('error' in pull2) throw new Error('unexpected');
    expect(pull2.blobs).toHaveLength(1);
    expect((pull2.blobs[0] as { client_proposed_id: string }).client_proposed_id).toBe('from-c');
  });

  it('idempotent push returns empty mappings on duplicate key', () => {
    const tenant = registry.register('free');
    createFile(registry, tenant.id, 'f1', 'salt');
    const blob = {
      proposed_id: 'p1',
      data: 'x',
      device_id: 'd1',
      updated_at: new Date().toISOString(),
    };
    const first = pushBlobs(registry, tenant.id, 'free', 'f1', 'dup-key', [blob]);
    expect(first).toHaveProperty('mappings');
    const second = pushBlobs(registry, tenant.id, 'free', 'f1', 'dup-key', [blob]);
    expect(second).toEqual({ mappings: [] });
  });
});
