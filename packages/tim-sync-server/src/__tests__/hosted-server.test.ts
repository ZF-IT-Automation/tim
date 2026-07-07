import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TenantRegistry } from '../tenant-registry.js';
import { createFile, pushBlobs } from '../storage.js';
import { startHostedSyncServer, type HostedServerHandle } from '../server.js';
import { TIER_QUOTAS } from '../quotas.js';

describe('tim-sync-server tenant isolation', () => {
  let tmp: string;
  let registry: TenantRegistry;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-srv-'));
    registry = new TenantRegistry(tmp);
  });

  afterEach(() => {
    registry.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('register creates unique tenant and token', () => {
    const a = registry.register('free');
    const b = registry.register('pro');
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(registry.resolveToken(a.token)?.id).toBe(a.id);
    expect(registry.resolveToken('bogus')).toBeNull();
  });

  it('tenants have isolated file namespaces', () => {
    const a = registry.register('free');
    const b = registry.register('free');
    createFile(registry, a.id, 'file-a', 'salt-a');
    createFile(registry, b.id, 'file-b', 'salt-b');
    expect(createFile(registry, a.id, 'file-a', 'x')).toEqual({ conflict: true });
    const filesB = registry.getTenantDb(b.id).prepare('SELECT id FROM files').all();
    expect(filesB).toHaveLength(1);
    registry.getTenantDb(b.id).close();
  });

  it('free tier blocks push over entry quota', () => {
    const tenant = registry.register('free');
    createFile(registry, tenant.id, 'f1', 'salt');
    const limit = TIER_QUOTAS.free.maxEntries!;
    const blobs = Array.from({ length: limit }, (_, i) => ({
      proposed_id: `p${i}`,
      data: 'x',
      device_id: 'd1',
      updated_at: new Date().toISOString(),
    }));
    const ok = pushBlobs(registry, tenant.id, 'free', 'f1', 'key1', blobs);
    expect(ok).toHaveProperty('mappings');
    const fail = pushBlobs(registry, tenant.id, 'free', 'f1', 'key2', [{
      proposed_id: 'overflow',
      data: 'y',
      device_id: 'd1',
      updated_at: new Date().toISOString(),
    }]);
    expect(fail).toMatchObject({ status: 402 });
  });

  it('pro tier allows more than free entry limit', () => {
    const tenant = registry.register('pro');
    createFile(registry, tenant.id, 'f1', 'salt');
    const limit = TIER_QUOTAS.free.maxEntries! + 5;
    const blobs = Array.from({ length: limit }, (_, i) => ({
      proposed_id: `p${i}`,
      data: 'x',
      device_id: 'd1',
      updated_at: new Date().toISOString(),
    }));
    const result = pushBlobs(registry, tenant.id, 'pro', 'f1', 'key-pro', blobs);
    expect(result).toHaveProperty('mappings');
  });
});

describe('tim-sync-server HTTP', () => {
  let tmp: string;
  let handle: HostedServerHandle;
  let baseUrl: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-http-'));
    handle = await startHostedSyncServer({ port: 0, dataDir: tmp });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('POST /register returns token and tenant_id', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { token: string; tenant_id: string; tier: string };
    expect(body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(body.tenant_id).toBeTruthy();
    expect(body.tier).toBe('free');
  });

  it('rejects unauthenticated /files', async () => {
    const res = await fetch(`${baseUrl}/files`);
    expect(res.status).toBe(401);
  });

  it('GET /health reports uptime and aggregates', async () => {
    await fetch(`${baseUrl}/register`, { method: 'POST', body: '{}' });
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.uptime_sec).toBe('number');
    expect(body.tenant_count).toBe(1);
  });

  it('authenticated sync status returns tier usage', async () => {
    const reg = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'free' }),
    });
    const { token } = await reg.json() as { token: string };
    const res = await fetch(`${baseUrl}/sync/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { tier: string; entry_count: number };
    expect(body.tier).toBe('free');
    expect(body.entry_count).toBe(0);
  });
});
