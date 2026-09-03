import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pruneToMaxBytes,
  parseSnapshotBudgetFromEnv,
  parseSnapshotBudgetStrict,
  snapshotHasRoom,
  makeRoomForSnapshot,
  snapshotFootprintBytes,
} from '../snapshot.js';
import {
  shouldCopyLiveDbForSafety,
  walSidecarsMayBeDropped,
  discardWalSidecars,
} from '../restore.js';
import { discoverTimMcpWriters } from '../writers.js';
import {
  checkpointOutputMeansFailure,
  parseCheckpointOutput,
  isStdioMcpCommand,
  stdioWritersToReap,
  computeWriteRateBytesPerSec,
} from '../wal-watchdog.js';

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

describe('parseSnapshotBudget', () => {
  const fallback = 8 * 1024 * 1024 * 1024;

  it('uses the fallback when env is missing', () => {
    expect(parseSnapshotBudgetFromEnv(undefined, fallback)).toEqual({ ok: true, value: fallback });
  });

  it('errors on empty, NaN, or negative explicit values', () => {
    expect(parseSnapshotBudgetStrict('')).toEqual({ ok: false, error: 'snapshot budget is empty' });
    expect(parseSnapshotBudgetStrict('not-a-number').ok).toBe(false);
    expect(parseSnapshotBudgetStrict('-1').ok).toBe(false);
    expect(parseSnapshotBudgetFromEnv('', fallback).ok).toBe(false);
  });

  it('keeps an explicit 0 (skip) and a finite positive cap', () => {
    expect(parseSnapshotBudgetStrict('0')).toEqual({ ok: true, value: 0 });
    expect(parseSnapshotBudgetStrict('1048576')).toEqual({ ok: true, value: 1048576 });
  });
});

describe('discoverTimMcpWriters', () => {
  it('accepts pgrep exit 1 as no writers', () => {
    const result = discoverTimMcpWriters(() => {
      const err = Object.assign(new Error('no match'), { status: 1 });
      throw err;
    });
    expect(result).toEqual({ ok: true, pids: [] });
  });

  it('refuses restore/compaction when pgrep itself fails', () => {
    const result = discoverTimMcpWriters(() => {
      throw Object.assign(new Error('pgrep broken'), { status: 2 });
    });
    expect(result.ok).toBe(false);
  });
});

describe('checkpoint parsing', () => {
  it('accepts 0|0|0 and rejects busy, malformed, empty, timeout', () => {
    expect(checkpointOutputMeansFailure('0|0|0')).toBe(false);
    expect(checkpointOutputMeansFailure('0 0 0')).toBe(false);
    expect(checkpointOutputMeansFailure('1|10|5')).toBe(true);
    expect(checkpointOutputMeansFailure('not-json')).toBe(true);
    expect(checkpointOutputMeansFailure('')).toBe(true);
    expect(checkpointOutputMeansFailure('timeout')).toBe(true);
  });

  it('parseCheckpointOutput returns structured triples', () => {
    expect(parseCheckpointOutput('0|3|3')).toEqual({ busy: 0, log: 3, checkpointed: 3 });
    expect(parseCheckpointOutput('1|10|5')).toEqual({ busy: 1, log: 10, checkpointed: 5 });
  });
});

describe('stdioWritersToReap write-rate selection', () => {
  const http = {
    pid: '10',
    ppid: '1',
    cmd: 'node /x/packages/tim-mcp/dist/server.js --http --port 3847',
    writeBytes: 9_000_000_000,
  };
  const orphan = {
    pid: '11',
    ppid: '1',
    cmd: 'node /x/packages/tim-mcp/dist/server.js',
    writeBytes: 100,
  };
  const quietCursor = {
    pid: '12',
    ppid: '500',
    cmd: 'node /x/packages/tim-mcp/dist/server.js',
    writeBytes: 8_000_000_000,
  };
  const runawayCodex = {
    pid: '13',
    ppid: '501',
    cmd: 'node /x/packages/tim-mcp/dist/server.js',
    writeBytes: 8_000_000_000,
  };

  it('reaps every PPID-1 stdio orphan and never the HTTP daemon', () => {
    const sample = { before: [http, orphan, quietCursor], after: [http, orphan, quietCursor], intervalMs: 2000 };
    expect(stdioWritersToReap(sample)).toEqual(['11']);
  });

  it('reaps only the process with high current write rate, not high lifetime bytes', () => {
    const before = [http, quietCursor, { ...runawayCodex, writeBytes: 100 }];
    const after = [http, quietCursor, runawayCodex];
    expect(stdioWritersToReap({ before, after, intervalMs: 1000 })).toEqual(['13']);
    expect(stdioWritersToReap({ before: [quietCursor], after: [quietCursor], intervalMs: 1000 })).toEqual([]);
  });

  it('kills nobody when two live parents have ambiguous similar rates', () => {
    const a = { pid: '20', ppid: '600', cmd: 'node /x/packages/tim-mcp/dist/server.js', writeBytes: 0 };
    const b = { pid: '21', ppid: '601', cmd: 'node /x/packages/tim-mcp/dist/server.js', writeBytes: 0 };
    const before = [a, b];
    const after = [
      { ...a, writeBytes: 2_000_000 },
      { ...b, writeBytes: 1_900_000 },
    ];
    expect(stdioWritersToReap({ before, after, intervalMs: 1000 }, { minRateBytesPerSec: 1 })).toEqual([]);
  });

  it('computeWriteRateBytesPerSec handles deltas', () => {
    expect(computeWriteRateBytesPerSec(100, 1_000_100, 1000)).toBe(1_000_000);
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

describe('snapshotHasRoom', () => {
  it('refuses when free space cannot hold the source db plus headroom', () => {
    expect(snapshotHasRoom({ sourceBytes: 2_000_000_000, freeBytes: 1_000_000_000 })).toBe(false);
  });

  it('allows a snapshot when free space covers the source file and 64 MiB headroom', () => {
    expect(snapshotHasRoom({ sourceBytes: 40_000_000, freeBytes: 200_000_000 })).toBe(true);
  });
});

describe('walSidecarsMayBeDropped', () => {
  it('refuses while any tim-mcp writer is still alive', () => {
    expect(walSidecarsMayBeDropped(['319499'])).toBe(false);
  });

  it('allows discard only when the writer list is empty', () => {
    expect(walSidecarsMayBeDropped([])).toBe(true);
  });
});

describe('makeRoomForSnapshot', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-snap-room-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prunes oldest snapshots before refusing, then aborts if still no room', () => {
    const t0 = Date.now() - 3600_000;
    fs.writeFileSync(path.join(dir, 'tim-20260903-0800.db'), Buffer.alloc(1000));
    fs.utimesSync(path.join(dir, 'tim-20260903-0800.db'), new Date(t0 / 1000), new Date(t0 / 1000));
    fs.writeFileSync(path.join(dir, 'tim-20260903-0900.db'), Buffer.alloc(1000));

    const result = makeRoomForSnapshot({
      dir,
      sourceBytes: 2_000_000_000,
      freeBytes: 1_000,
      pruneHours: 0,
      maxBytes: 8 * 1024 * 1024 * 1024,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/free disk/i);
    expect(fs.existsSync(path.join(dir, 'tim-20260903-0800.db'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'tim-20260903-0900.db'))).toBe(true);
  });

  it('does not delete the only remaining snapshot when there is no room', () => {
    const old = Date.now() - 50 * 3600 * 1000;
    const only = path.join(dir, 'tim-20260901-0830.db');
    fs.writeFileSync(only, Buffer.alloc(1000));
    fs.utimesSync(only, new Date(old / 1000), new Date(old / 1000));

    const result = makeRoomForSnapshot({
      dir,
      sourceBytes: 2_000_000_000,
      freeBytes: 1_000,
      pruneHours: 48,
      maxBytes: 8 * 1024 * 1024 * 1024,
    });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(only)).toBe(true);
  });
});

describe('isStdioMcpCommand', () => {
  it('selects stdio writers and leaves the HTTP daemon alone', () => {
    expect(isStdioMcpCommand('node /home/bbbee/projects/tim/packages/tim-mcp/dist/server.js')).toBe(true);
    expect(
      isStdioMcpCommand('node /home/bbbee/projects/tim/packages/tim-mcp/dist/server.js --http --port 3847'),
    ).toBe(false);
  });
});

describe('discardWalSidecars', () => {
  it('treats a missing sidecar as success', () => {
    const result = discardWalSidecars(['/tmp/missing-wal'], () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    expect(result.ok).toBe(true);
  });

  it('aborts on non-ENOENT unlink errors', () => {
    const result = discardWalSidecars(['/tmp/tim.db-wal'], () => {
      const err = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      throw err;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe('/tmp/tim.db-wal');
  });
});

describe('snapshotFootprintBytes', () => {
  it('adds the WAL file size so room checks cover a consistent backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-snap-foot-'));
    try {
      const dbPath = path.join(dir, 'tim.db');
      fs.writeFileSync(dbPath, Buffer.alloc(1000));
      fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(4000));
      expect(snapshotFootprintBytes(dbPath)).toBe(5000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
