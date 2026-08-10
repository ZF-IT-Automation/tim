import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readTimSessionCache,
  resolveActiveSessionId,
  timSessionCachePath,
} from '../session-cache.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-cache-'));

describe('session-cache', () => {
  beforeEach(() => {
    process.env.TIM_CACHE_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.TIM_CACHE_DIR;
    delete process.env.TIM_SESSION_ID;
    for (const f of fs.readdirSync(tmp)) {
      fs.rmSync(path.join(tmp, f), { force: true });
    }
  });

  it('resolveActiveSessionId priority: arg > env > cache > marker', () => {
    fs.writeFileSync(
      timSessionCachePath(),
      JSON.stringify({ session_id: 'from-cache', cwd: '/x' }),
    );
    process.env.TIM_SESSION_ID = 'from-env';

    expect(
      resolveActiveSessionId({
        sessionIdArg: 'from-arg',
        markerSession: 'from-marker',
      }),
    ).toBe('from-arg');

    expect(
      resolveActiveSessionId({ markerSession: 'from-marker' }),
    ).toBe('from-env');

    delete process.env.TIM_SESSION_ID;
    expect(
      resolveActiveSessionId({ markerSession: 'from-marker', cwd: '/x' }),
    ).toBe('from-cache');

    fs.unlinkSync(timSessionCachePath());
    expect(
      resolveActiveSessionId({ markerSession: 'from-marker', cwd: '/x' }),
    ).toBe('from-marker');
  });

  it('ignores a cache entry written from another directory', () => {
    // The observed fault: a cronjob running in ~/.hermes overwrote the slot
    // while an interactive session was working in a project directory.
    fs.writeFileSync(
      timSessionCachePath(),
      JSON.stringify({ session_id: 'cron_0b4a52226e21', cwd: '/home/bbbee/.hermes' }),
    );
    expect(readTimSessionCache(60_000, '/home/bbbee/projects/tim')).toBeNull();
    expect(
      resolveActiveSessionId({ cwd: '/home/bbbee/projects/tim', markerSession: 'from-marker' }),
    ).toBe('from-marker');
    expect(
      resolveActiveSessionId({ cwd: '/home/bbbee/projects/tim' }),
    ).toBeUndefined();
  });

  it('rejects the writer\'s $HOME fallback rather than treating it as an ancestor', () => {
    // tim-hermes-session-cache.sh writes `cwd: $HOME` when the payload carries
    // no cwd — under prefix matching that entry would belong to everyone.
    fs.writeFileSync(
      timSessionCachePath(),
      JSON.stringify({ session_id: 'homeless', cwd: os.homedir() }),
    );
    expect(readTimSessionCache(60_000, path.join(os.homedir(), 'projects/tim'))).toBeNull();
  });

  it('skips the cache when the caller names no cwd', () => {
    fs.writeFileSync(
      timSessionCachePath(),
      JSON.stringify({ session_id: 'unowned', cwd: '/x' }),
    );
    expect(resolveActiveSessionId({})).toBeUndefined();
    expect(readTimSessionCache(60_000)?.session_id).toBe('unowned');
  });

  it('readTimSessionCache respects maxAgeMs', () => {
    fs.writeFileSync(
      timSessionCachePath(),
      JSON.stringify({ session_id: 'stale', cwd: '/' }),
    );
    const past = Date.now() - 10_000;
    fs.utimesSync(timSessionCachePath(), past / 1000, past / 1000);
    expect(readTimSessionCache(1000)).toBeNull();
    expect(readTimSessionCache(60_000)?.session_id).toBe('stale');
  });

  it('useSessionCache:false skips the global cache file', () => {
    fs.writeFileSync(
      timSessionCachePath(),
      JSON.stringify({ session_id: 'CACHED-1', cwd: '/x' }),
    );
    const resolved = resolveActiveSessionId({ useSessionCache: false, useEnv: false });
    expect(resolved).toBeUndefined();
  });

  it('explicit arg still wins regardless of flags', () => {
    fs.writeFileSync(
      timSessionCachePath(),
      JSON.stringify({ session_id: 'CACHED-2', cwd: '/y' }),
    );
    process.env.TIM_SESSION_ID = 'FROM-ENV';
    expect(
      resolveActiveSessionId({ sessionIdArg: 'ARG-1', useSessionCache: false, useEnv: false })
    ).toBe('ARG-1');
    delete process.env.TIM_SESSION_ID;
  });

  it('useEnv:false skips TIM_SESSION_ID env var', () => {
    process.env.TIM_SESSION_ID = 'FROM-ENV';
    // No cache file, no arg — env would normally win, but useEnv:false skips it
    const resolved = resolveActiveSessionId({ useEnv: false, useSessionCache: false });
    expect(resolved).toBeUndefined();
    delete process.env.TIM_SESSION_ID;
  });
});
