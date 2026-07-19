import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import {
  TimStore,
  KIND_PROJECT_PATH,
  upsertProjectPathRow,
  listProjectPathRows,
  isStalePathRow,
  DEFAULT_STALE_PATH_MAX_AGE_DAYS,
} from '../index.js';

describe('project-path inventory', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('upserting the same (device, path) twice yields one row with advanced last_seen_at', async () => {
    await store.createProject('P0063');
    const absPath = path.resolve('/home/user/projects/tim');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T10:00:00Z'));
    const first = await upsertProjectPathRow(store, 'P0063', 'local', absPath);
    expect(first.metadata.kind).toBe(KIND_PROJECT_PATH);
    expect(first.metadata.device).toBe('local');
    expect(first.metadata.path).toBe(absPath);
    expect(first.metadata.last_seen_at).toBe('2026-07-01T10:00:00.000Z');

    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    const second = await upsertProjectPathRow(store, 'P0063', 'local', absPath);
    expect(second.id).toBe(first.id);

    const rows = await listProjectPathRows(store, 'P0063');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.last_seen_at).toBe('2026-07-19T12:00:00.000Z');
  });

  it('two devices yield two rows', async () => {
    await store.createProject('P0063');
    const absPath = path.resolve('/home/user/projects/tim');

    await upsertProjectPathRow(store, 'P0063', 'device-a', absPath);
    await upsertProjectPathRow(store, 'P0063', 'device-b', absPath);

    const rows = await listProjectPathRows(store, 'P0063');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.metadata.device).sort()).toEqual(['device-a', 'device-b']);
    expect(rows.every(r => r.metadata.path === absPath)).toBe(true);
  });

  it('listProjectPathRows returns device, path, and last_seen_at', async () => {
    await store.createProject('P0064');
    const absPath = path.resolve('/var/work/my-app');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T08:30:00Z'));
    await upsertProjectPathRow(store, 'P0064', 'laptop', absPath);

    const rows = await listProjectPathRows(store, 'P0064');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      kind: KIND_PROJECT_PATH,
      device: 'laptop',
      path: absPath,
      last_seen_at: '2026-06-15T08:30:00.000Z',
    });
  });

  it('isStalePathRow flags a row older than the threshold', () => {
    const now = new Date('2026-07-19T00:00:00Z').getTime();
    const fresh = {
      id: 'fresh',
      metadata: { last_seen_at: '2026-07-10T00:00:00.000Z' },
    } as Parameters<typeof isStalePathRow>[0];
    const stale = {
      id: 'stale',
      metadata: { last_seen_at: '2026-05-01T00:00:00.000Z' },
    } as Parameters<typeof isStalePathRow>[0];

    expect(isStalePathRow(fresh, now, DEFAULT_STALE_PATH_MAX_AGE_DAYS)).toBe(false);
    expect(isStalePathRow(stale, now, DEFAULT_STALE_PATH_MAX_AGE_DAYS)).toBe(true);
  });

  it('isStalePathRow treats missing last_seen_at as stale', () => {
    const row = { id: 'bad', metadata: {} } as Parameters<typeof isStalePathRow>[0];
    expect(isStalePathRow(row)).toBe(true);
  });
});
