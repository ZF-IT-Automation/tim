import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pruneToMaxBytes } from '../snapshot.js';
import { shouldCopyLiveDbForSafety } from '../restore.js';

describe('shouldCopyLiveDbForSafety', () => {
  const GB = 1024 * 1024 * 1024;

  it('skips a copy that would leave less than 1 GB free', () => {
    expect(shouldCopyLiveDbForSafety(32 * GB, 2 * GB, 55 * GB)).toBe(false);
  });

  it('skips a bloated live file many times larger than the snapshot', () => {
    expect(shouldCopyLiveDbForSafety(32 * GB, 2 * GB, 200 * GB)).toBe(false);
  });

  it('copies when live and snapshot are similar and disk has headroom', () => {
    expect(shouldCopyLiveDbForSafety(40 * 1024 * 1024, 38 * 1024 * 1024, 10 * GB)).toBe(true);
  });
});

describe('pruneToMaxBytes', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-snap-prune-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeSnap(name: string, bytes: number, mtimeMs: number): void {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(bytes));
    fs.utimesSync(p, new Date(mtimeMs / 1000), new Date(mtimeMs / 1000));
  }

  it('deletes oldest snapshots until the directory is under budget, keeps newest', () => {
    const t0 = Date.now() - 3600_000;
    writeSnap('tim-20260903-0800.db', 1000, t0);
    writeSnap('tim-20260903-0830.db', 1000, t0 + 1800_000);
    writeSnap('tim-20260903-0900.db', 1000, t0 + 3600_000);

    const removed = pruneToMaxBytes(dir, 1500);
    expect(removed).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['tim-20260903-0900.db']);
  });

  it('never deletes the newest snapshot even if it exceeds the budget', () => {
    writeSnap('tim-20260903-0900.db', 5000, Date.now());
    expect(pruneToMaxBytes(dir, 100)).toBe(0);
    expect(fs.readdirSync(dir)).toEqual(['tim-20260903-0900.db']);
  });
});
