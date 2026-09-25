import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantRegistry } from '../tenant-registry.js';
import { createFile, pushBlobs } from '../storage.js';

let dir: string; let registry: TenantRegistry; let tenant: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retry-quota-')); registry = new TenantRegistry(dir);
  tenant = registry.register().id; createFile(registry, tenant, 'f', 'salt');
});
afterEach(() => { registry.close(); rmSync(dir, { recursive: true, force: true }); });
const blob = (key: string, data = 'x', time = 10, type: 'entry' | 'edge' = 'entry', device = 'a') => ({
  proposed_id: key, entity_key: key, entity_type: type, data, device_id: 'forwarder',
  updated_at: new Date(time).toISOString(), lww_device: device,
});
it('replays the stored result at quota, rejects changed requests, and survives reopen', () => {
  const blobs = Array.from({ length: 1000 }, (_, i) => blob(String(i)));
  const first = pushBlobs(registry, tenant, 'free', 'f', 'key', blobs);
  expect(first).toHaveProperty('mappings');
  registry.close(); registry = new TenantRegistry(dir);
  expect(pushBlobs(registry, tenant, 'free', 'f', 'key', blobs)).toEqual(first);
  expect(pushBlobs(registry, tenant, 'free', 'f', 'key', [blob('different')])).toMatchObject({ status: 409 });
  expect(pushBlobs(registry, tenant, 'free', 'f', 'overflow', [blob('1001')])).toMatchObject({ status: 402 });
  expect(registry.getUsage(tenant)).toEqual({ entryCount: 1000, totalBytes: 1000 });
  const db = registry.getTenantDb(tenant);
  expect(db.prepare("SELECT * FROM idempotency WHERE key='overflow'").get()).toBeUndefined(); db.close();
});
it('groups by file/type/key and replaces bytes by logical winner including device tiebreaks', () => {
  createFile(registry, tenant, 'g', 'salt');
  pushBlobs(registry, tenant, 'free', 'f', '1', [blob('k', 'aaaa', 20, 'entry', 'z')]);
  pushBlobs(registry, tenant, 'free', 'f', '2', [blob('k', 'stale-large', 10)]);
  pushBlobs(registry, tenant, 'free', 'f', '3', [blob('k', 'equal-time-loser', 20)]);
  expect(registry.getUsage(tenant)).toEqual({ entryCount: 1, totalBytes: 4 });
  pushBlobs(registry, tenant, 'free', 'f', '4', [blob('k', 'ü', 30), blob('k', 'e', 30, 'edge')]);
  pushBlobs(registry, tenant, 'free', 'g', '5', [blob('k', 'g', 30)]);
  expect(registry.getUsage(tenant)).toEqual({ entryCount: 3, totalBytes: 4 });
});
it('retains ambiguous maxima and counts the largest ciphertext', () => {
  pushBlobs(registry, tenant, 'free', 'f', '1', [blob('k', 'x'), blob('k', 'yyy')]);
  expect(registry.getUsage(tenant)).toEqual({ entryCount: 1, totalBytes: 3 });
  const db = registry.getTenantDb(tenant);
  expect(db.prepare('SELECT COUNT(*) AS c FROM blobs').get()).toEqual({ c: 2 }); db.close();
});
