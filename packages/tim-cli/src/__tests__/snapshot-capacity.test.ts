import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pruneToMaxBytes,
  parseSnapshotBudget,
  snapshotHasRoom,
  makeRoomForSnapshot,
  snapshotFootprintBytes,
} from '../snapshot.js';
import {
  shouldCopyLiveDbForSafety,
  walSidecarsMayBeDropped,
  discardWalSidecars,
} from '../restore.js';
import {
  checkpointOutputMeansFailure,
  isStdioMcpCommand,
  stdioWritersToReap,
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

describe('parseSnapshotBudget', () => {
  const fallback = 8 * 1024 * 1024 * 1024;

  it('uses the fallback for missing, NaN, or negative values instead of disabling prune', () => {
    expect(parseSnapshotBudget(undefined, fallback)).toBe(fallback);
    expect(parseSnapshotBudget('', fallback)).toBe(fallback);
    expect(parseSnapshotBudget('not-a-number', fallback)).toBe(fallback);
    expect(parseSnapshotBudget('-1', fallback)).toBe(fallback);
  });

  it('keeps an explicit 0 (skip) and a finite positive cap', () => {
    expect(parseSnapshotBudget('0', fallback)).toBe(0);
    expect(parseSnapshotBudget('1048576', fallback)).toBe(1048576);
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

  it('stops pruning once free space covers the source plus headroom', () => {
    const t0 = Date.now() - 3600_000;
    fs.writeFileSync(path.join(dir, 'tim-20260903-0700.db'), Buffer.alloc(80_000_000));
    fs.utimesSync(path.join(dir, 'tim-20260903-0700.db'), new Date(t0 / 1000), new Date(t0 / 1000));
    fs.writeFileSync(path.join(dir, 'tim-20260903-0800.db'), Buffer.alloc(80_000_000));
    fs.utimesSync(
      path.join(dir, 'tim-20260903-0800.db'),
      new Date((t0 + 1800_000) / 1000),
      new Date((t0 + 1800_000) / 1000),
    );
    fs.writeFileSync(path.join(dir, 'tim-20260903-0900.db'), Buffer.alloc(1000));

    const result = makeRoomForSnapshot({
      dir,
      sourceBytes: 1_000,
      freeBytes: 1_000,
      pruneHours: 0,
      maxBytes: 8 * 1024 * 1024 * 1024,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tim-20260903-0700.db'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'tim-20260903-0800.db'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tim-20260903-0900.db'))).toBe(true);
  });

  it('succeeds without pruning when free space already covers the source', () => {
    const result = makeRoomForSnapshot({
      dir,
      sourceBytes: 40_000_000,
      freeBytes: 200_000_000,
      pruneHours: 0,
      maxBytes: 8 * 1024 * 1024 * 1024,
    });
    expect(result.ok).toBe(true);
    expect(result.pruned).toBe(0);
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

describe('checkpointOutputMeansFailure', () => {
  it('treats timeout and empty checkpoint output as failure, not success', () => {
    expect(checkpointOutputMeansFailure('timeout')).toBe(true);
    expect(checkpointOutputMeansFailure('')).toBe(true);
    expect(checkpointOutputMeansFailure('0 0 0')).toBe(false);
  });
});

describe('isStdioMcpCommand', () => {
  it('selects stdio writers and leaves the HTTP daemon alone', () => {
    expect(
      isStdioMcpCommand('node /home/bbbee/projects/tim/packages/tim-mcp/dist/server.js'),
    ).toBe(true);
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

  it('fails open no longer: EBUSY aborts instead of continuing', () => {
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

describe('stdioWritersToReap', () => {
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
    writeBytes: 50,
  };
  const runawayCodex = {
    pid: '13',
    ppid: '501',
    cmd: 'node /x/packages/tim-mcp/dist/server.js',
    writeBytes: 8_000_000_000,
  };

  it('reaps every PPID-1 stdio orphan and never the HTTP daemon', () => {
    expect(stdioWritersToReap([http, orphan, quietCursor])).toEqual(['11']);
  });

  it('reaps only the hottest live-parent stdio writer, not every client', () => {
    expect(stdioWritersToReap([http, quietCursor, runawayCodex])).toEqual(['13']);
  });
});
