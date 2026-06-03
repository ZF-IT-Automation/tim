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
      resolveActiveSessionId({ markerSession: 'from-marker' }),
    ).toBe('from-cache');

    fs.unlinkSync(timSessionCachePath());
    expect(
      resolveActiveSessionId({ markerSession: 'from-marker' }),
    ).toBe('from-marker');
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
});
