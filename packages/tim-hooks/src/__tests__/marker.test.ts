import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as markerModule from '../marker.js';
import {
  readMarker,
  writeMarker,
  writeMarkerAtomic,
  writeMarkerExclusive,
  ExclusiveMarkerConflictError,
  detectProject,
  discoverMarker,
  findMarker,
  CWD_ONLY_MARKER_DISCOVERY_POLICY,
  DEFAULT_MARKER_DISCOVERY_POLICY,
  syncNearestProjectMarker,
  buildLoadDirective,
  acquireLock,
  releaseLock,
  summarizerLockPath,
  validateMarkerAgainstStore,
  validateProjectLabel,
  isUnsafeMarkerDir,
  INBOX_LABEL,
  MARKER_VERSION,
} from '../marker.js';
import { TimStore } from 'tim-store';

const markerIoFaults = vi.hoisted(() => ({
  uuid: null as string | null,
  linkError: null as Error | null,
  cleanupError: null as Error | null,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => markerIoFaults.uuid ?? actual.randomUUID(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (markerIoFaults.linkError) throw markerIoFaults.linkError;
      return actual.linkSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (markerIoFaults.cleanupError && String(args[0]).includes('.tim-project.tmp.')) {
        throw markerIoFaults.cleanupError;
      }
      return actual.rmSync(...args);
    },
  };
});

/** Outside ~ so findMarker walk-up does not hit real ~/.tim-project */
const TEST_ROOT = '/tmp/tim-test-runs';

function markerOnDisk(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
}

describe('marker', () => {
  let dir: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'marker-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotateMarkerSession and reconcileMarker are removed from the module', () => {
    expect(markerModule).not.toHaveProperty('rotateMarkerSession');
    expect(markerModule).not.toHaveProperty('reconcileMarker');
  });

  it('round-trips a v3 marker file', () => {
    writeMarker(dir, { project: 'P0001' });
    expect(readMarker(dir)).toEqual({ version: 3, project: 'P0001' });
    expect(markerOnDisk(dir)).toEqual({ version: 3, project: 'P0001' });
  });

  it('detectProject prefers the .tim-project marker', () => {
    writeMarker(dir, { project: 'P0009' });
    expect(detectProject(dir)?.project).toBe('P0009');
  });

  it('detectProject returns null when no marker exists', () => {
    expect(detectProject(dir)).toBeNull();
  });

  it('readMarker falls back to tim.json when no .tim-project exists', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0063' }));
    expect(readMarker(dir)).toEqual({ version: 3, project: 'P0063' });
  });

  it('readMarker prefers .tim-project over tim.json', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0062' }));
    writeMarker(dir, { project: 'P0063' });
    expect(readMarker(dir)?.project).toBe('P0063');
  });

  it('findMarker walks up to parent tim.json when no .tim-project exists', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0063' }));
    const sub = path.join(dir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })?.marker.project).toBe('P0063');
  });

  it('acquireLock single-flights: second acquire fails while the lock is fresh', () => {
    expect(acquireLock(dir)).toBe(true);
    expect(fs.existsSync(summarizerLockPath(dir))).toBe(true);
    expect(acquireLock(dir)).toBe(false);
    releaseLock(dir);
    expect(acquireLock(dir)).toBe(true);
  });

  it('acquireLock ignores a leftover .tim-project.lock at cwd root', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project.lock'),
      JSON.stringify({ pid: process.pid, ts: Date.now() }),
    );
    expect(acquireLock(dir)).toBe(true);
    expect(fs.existsSync(summarizerLockPath(dir))).toBe(true);
  });

  it('findMarker returns the marker in the cwd itself', () => {
    writeMarker(dir, { project: 'P0001' });
    const found = findMarker(dir, { maxRoot: dir });
    expect(found?.marker.project).toBe('P0001');
    expect(found?.dir).toBe(fs.realpathSync(dir));
  });

  it('findMarker walks up to a parent marker', () => {
    writeMarker(dir, { project: 'P0002' });
    const sub = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })?.marker.project).toBe('P0002');
  });

  it('findMarker: nearest marker wins over an ancestor', () => {
    writeMarker(dir, { project: 'P0002' });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(sub, { project: 'P0003' });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })?.marker.project).toBe('P0003');
  });

  it('findMarker: repo marker wins over ~/.tim-project on the same walk chain', () => {
    const fakeHome = path.join(dir, 'fake-home');
    const repo = path.join(fakeHome, 'projects', 'tim');
    const sub = path.join(repo, 'packages');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(fakeHome, { project: 'P0099' });
    writeMarker(repo, { project: 'P0063' });
    const found = findMarker(sub, { maxRoot: fakeHome, walkUp: true });
    expect(found?.marker.project).toBe('P0063');
    expect(found?.dir).toBe(fs.realpathSync(repo));
  });

  it('findMarker returns null when no marker exists up to root (no infinite loop)', () => {
    const sub = path.join(dir, 'x', 'y');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })).toBeNull();
  });

  it('findMarker stops at a corrupt nearest marker (does not silently use an ancestor)', () => {
    writeMarker(dir, { project: 'P0002' });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.tim-project'), '{ not valid json');
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })).toBeNull();
  });

  it('findMarker returns null for parent marker when walkUp is not set (cwd-only default)', () => {
    writeMarker(dir, { project: 'P0002' });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub)).toBeNull();
  });

  it('findMarker returns cwd marker without walkUp option', () => {
    writeMarker(dir, { project: 'P0001' });
    expect(findMarker(dir)?.marker.project).toBe('P0001');
  });

  describe('findMarker allowHome', () => {
    let homeDir: string;
    let savedHome: string | undefined;

    beforeEach(() => {
      homeDir = fs.mkdtempSync(path.join(TEST_ROOT, 'fake-home-'));
      savedHome = process.env.HOME;
      process.env.HOME = homeDir;
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    it('skips home ancestor when allowHome is false', () => {
      writeMarker(homeDir, { project: 'P0099' });
      const sub = path.join(homeDir, 'projects', 'repo');
      fs.mkdirSync(sub, { recursive: true });
      expect(findMarker(sub, { maxRoot: homeDir, walkUp: true, allowHome: false })).toBeNull();
    });

    it('returns home ancestor when allowHome is true', () => {
      writeMarker(homeDir, { project: 'P0099' });
      const sub = path.join(homeDir, 'projects', 'repo');
      fs.mkdirSync(sub, { recursive: true });
      expect(findMarker(sub, { maxRoot: homeDir, walkUp: true, allowHome: true })?.marker.project).toBe(
        'P0099',
      );
    });

    it('returns home marker when cwd is home even if allowHome is false', () => {
      writeMarker(homeDir, { project: 'P0099' });
      expect(findMarker(homeDir, { walkUp: true, allowHome: false })?.marker.project).toBe('P0099');
    });
  });

  it.each(['notalabel', '12345', 'P12345', 'P', 'P0', 'p0062', 'P006', 'P0062X'])(
    'readMarker returns null for malformed project label %s',
    (bad) => {
      fs.writeFileSync(
        path.join(dir, '.tim-project'),
        JSON.stringify({
          project: bad,
          session: 's',
          exchanges: 0,
          batch_size: 5,
          batches_summarized: 0,
          version: 2,
        }),
      );
      expect(readMarker(dir)).toBeNull();
    },
  );

  it('readMarker returns null for empty project string and wrong-type project', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: '',
        session: 's',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
        version: 2,
      }),
    );
    expect(readMarker(dir)).toBeNull();
  });

  it('readMarker accepts valid P/L/E/N-prefixed labels', () => {
    for (const label of ['P0062', 'L0042', 'E0031', 'N0014']) {
      fs.writeFileSync(
        path.join(dir, '.tim-project'),
        JSON.stringify({
          project: label,
          session: 's',
          exchanges: 0,
          batch_size: 5,
          batches_summarized: 0,
          version: 2,
        }),
      );
      expect(readMarker(dir)?.project).toBe(label);
    }
  });

  it('findMarker returns null when the only marker has a malformed project label', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: 'notalabel',
        session: 's',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
        version: 2,
      }),
    );
    const sub = path.join(dir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })).toBeNull();
  });

  it('buildLoadDirective embeds the label and the load instruction', () => {
    const d = buildLoadDirective('P0063', '/home/bbbee/projects/tim');
    expect(d).toContain('P0063');
    expect(d).toContain('tim_load_project(label="P0063")');
    expect(d).toContain('.tim-project');
  });

  it('buildLoadDirective shows binding label but keeps tool arg as project id', () => {
    const d = buildLoadDirective('P0062', '/repo', 'P0062 — bbbee PM Workflow');
    expect(d).toContain('TIM project P0062 — bbbee PM Workflow');
    expect(d).toContain('tim_load_project(label="P0062")');
  });

  it('syncNearestProjectMarker overwrites project on nearest marker', () => {
    writeMarker(dir, { project: 'P0062' });
    const sub = path.join(dir, 'repo');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(sub, { project: 'P0062' });

    expect(
      syncNearestProjectMarker(sub, 'P0063', {
        findOptions: { maxRoot: dir },
      }),
    ).toBe(true);
    expect(readMarker(sub)).toEqual({ version: 3, project: 'P0063' });
    expect(readMarker(dir)).toEqual({ version: 3, project: 'P0062' });
  });

  it('writeMarker refuses to write P9999 (invalid label — 5 digits)', () => {
    expect(validateProjectLabel('P9999')).toBe(false);
    writeMarker(dir, { project: 'P9999' });
    const markerFile = path.join(dir, '.tim-project');
    const exists = fs.existsSync(markerFile);
    if (exists) {
      const content = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      expect(content.project).not.toBe('P9999');
    }
  });

  it('syncNearestProjectMarker with P9999 returns false and does not write', () => {
    writeMarker(dir, { project: 'P0062' });
    const result = syncNearestProjectMarker(dir, 'P9999', {
      findOptions: { maxRoot: dir },
    });
    expect(result).toBe(false);
    expect(readMarker(dir)?.project).toBe('P0062');
  });
});

describe('marker v3 schema', () => {
  let dir: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'marker-v3-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeMarker stamps the current version on disk with only project + version', () => {
    writeMarker(dir, { project: 'P0001' });
    expect(markerOnDisk(dir)).toEqual({ version: 3, project: 'P0001' });
    expect(Object.keys(markerOnDisk(dir))).toEqual(['version', 'project']);
  });

  it('readMarker returns the v3 shape', () => {
    writeMarker(dir, { project: 'P0001' });
    const m = readMarker(dir);
    expect(m).toEqual({ version: 3, project: 'P0001' });
    expect(MARKER_VERSION).toBe(3);
  });

  it('readMarker normalizes a v2 file to v3, ignoring runtime fields', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        version: 2,
        project: 'P0063',
        session: 'bg',
        exchanges: 42,
        batch_size: 5,
        batches_summarized: 2,
      }, null, 2),
    );

    expect(readMarker(dir)).toEqual({ version: 3, project: 'P0063' });
  });

  it('readMarker normalizes a v1 file (no version field) to v3, ignoring legacy fields', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: 'P0062',
        session: 'bg',
        exchanges: 42,
        batch_size: 5,
        batches_summarized: 2,
        route_exchanges_to: 'P0063',
        sessions: { P0063: '20260602_155620_ee0929' },
      }, null, 2),
    );

    expect(readMarker(dir)).toEqual({ version: 3, project: 'P0062' });
  });

  it('readMarker does NOT rewrite the v1 file on read', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: 'P0062',
        session: 'bg',
        exchanges: 42,
        batch_size: 5,
        batches_summarized: 2,
        route_exchanges_to: 'P0063',
      }, null, 2),
    );

    readMarker(dir);

    const onDisk = markerOnDisk(dir);
    expect(onDisk.version).toBeUndefined();
    expect(onDisk.route_exchanges_to).toBe('P0063');
  });

  it('the first write to a v1 file upgrades it to v3 on disk', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: 'P0062',
        session: 'bg',
        exchanges: 42,
        batch_size: 5,
        batches_summarized: 2,
        route_exchanges_to: 'P0063',
        sessions: { P0063: 'old' },
      }, null, 2),
    );

    writeMarker(dir, { project: 'P0062' });

    expect(markerOnDisk(dir)).toEqual({ version: 3, project: 'P0062' });
  });

  it('readMarker accepts v2 files missing runtime numeric fields (label-only read)', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: 'P0001',
        version: 2,
      }, null, 2),
    );
    expect(readMarker(dir)).toEqual({ version: 3, project: 'P0001' });
  });

  it('ProjectMarkerInput accepts a marker without version (writer fills it in)', () => {
    const input: Parameters<typeof writeMarker>[1] = { project: 'P0001' };
    writeMarker(dir, input);
    expect(readMarker(dir)?.version).toBe(3);
  });
});

describe('validateMarkerAgainstStore', () => {
  let store: TimStore;
  beforeEach(() => {
    store = new TimStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('rejects a pattern-valid label that has no matching DB entry (P9999 case)', async () => {
    await store.createProject('P0062');
    const bogus = { version: 3 as const, project: 'P9999' };
    expect(await validateMarkerAgainstStore(bogus, store)).toBeNull();
  });

  it('accepts a label that resolves to a real project, returning the canonical form', async () => {
    await store.createProject('P0062');
    const ok = { version: 3 as const, project: 'P0062' };
    const validated = await validateMarkerAgainstStore(ok, store);
    expect(validated?.project).toBe('P0062');
  });

  it('accepts the Inbox (P0000) even when it is not yet materialized in the DB', async () => {
    const inbox = { version: 3 as const, project: INBOX_LABEL };
    const validated = await validateMarkerAgainstStore(inbox, store);
    expect(validated?.project).toBe('P0000');
  });

  it('fails open (accepts) when the DB lookup itself throws — pattern check still gates', async () => {
    const ok = { version: 3 as const, project: 'P0062' };
    const broken = {
      resolveProjectLabel: () => {
        throw new Error('db locked');
      },
    } as unknown as Pick<TimStore, 'resolveProjectLabel'>;
    expect(await validateMarkerAgainstStore(ok, broken)).toEqual(ok);
  });
});

describe('discoverMarker policy', () => {
  let dir: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'discover-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cwd-only policy does not walk to parent', () => {
    writeMarker(dir, { project: 'P0002' });
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    expect(discoverMarker(sub, CWD_ONLY_MARKER_DISCOVERY_POLICY)).toBeNull();
    expect(discoverMarker(sub, { ...CWD_ONLY_MARKER_DISCOVERY_POLICY, walkUp: true, maxRoot: dir })?.marker.project)
      .toBe('P0002');
  });

  it('default policy walks up like syncNearestProjectMarker', () => {
    writeMarker(dir, { project: 'P0002' });
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    expect(discoverMarker(sub, { ...DEFAULT_MARKER_DISCOVERY_POLICY, maxRoot: dir })?.marker.project)
      .toBe('P0002');
  });
});

describe('marker atomic writes', () => {
  let dir: string;

  beforeEach(() => {
    markerIoFaults.uuid = null;
    markerIoFaults.linkError = null;
    markerIoFaults.cleanupError = null;
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'atomic-'));
  });

  afterEach(() => {
    markerIoFaults.uuid = null;
    markerIoFaults.linkError = null;
    markerIoFaults.cleanupError = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeMarkerAtomic never leaves torn JSON on rapid rewrites', () => {
    const p = path.join(dir, '.tim-project');
    writeMarker(dir, { project: 'P0001' });
    for (let i = 0; i < 200; i++) {
      writeMarkerAtomic(p, JSON.stringify({ version: 3, project: 'P0001' }, null, 2));
      const raw = fs.readFileSync(p, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('writeMarkerExclusive publishes a complete v3 marker without temp residue', () => {
    const marker = writeMarkerExclusive(dir, { project: 'P0042' });

    expect(marker).toEqual({ version: 3, project: 'P0042' });
    expect(readMarker(dir)).toEqual(marker);
    expect(markerOnDisk(dir)).toEqual({ version: 3, project: 'P0042' });
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('writeMarkerExclusive preserves an existing winner and removes its temp file', () => {
    writeMarkerExclusive(dir, { project: 'P0043' });
    const markerFile = path.join(dir, '.tim-project');
    const winnerBytes = fs.readFileSync(markerFile);

    expect(() => writeMarkerExclusive(dir, { project: 'P0042' })).toThrow(ExclusiveMarkerConflictError);
    expect(fs.readFileSync(markerFile)).toEqual(winnerBytes);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('writeMarkerExclusive preserves a colliding temp file it did not create', () => {
    markerIoFaults.uuid = '00000000-0000-4000-8000-000000000042';
    const markerFile = path.join(dir, '.tim-project');
    const tempFile = `${markerFile}.tmp.${process.pid}.${markerIoFaults.uuid}`;
    const collisionBytes = Buffer.from('owned by another publisher');
    fs.writeFileSync(tempFile, collisionBytes);

    expect(() => writeMarkerExclusive(dir, { project: 'P0042' })).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readFileSync(tempFile)).toEqual(collisionBytes);
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it('writeMarkerExclusive rethrows a non-EEXIST link error and removes its temp file', () => {
    markerIoFaults.uuid = '00000000-0000-4000-8000-000000000043';
    const linkError = Object.assign(new Error('link denied'), { code: 'EPERM' });
    markerIoFaults.linkError = linkError;
    const markerFile = path.join(dir, '.tim-project');
    const tempFile = `${markerFile}.tmp.${process.pid}.${markerIoFaults.uuid}`;

    expect(() => writeMarkerExclusive(dir, { project: 'P0042' })).toThrow(linkError);
    expect(fs.existsSync(tempFile)).toBe(false);
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it('writeMarkerExclusive cleanup failure does not mask a publication error', () => {
    markerIoFaults.uuid = '00000000-0000-4000-8000-000000000044';
    const linkError = Object.assign(new Error('link failed'), { code: 'EACCES' });
    markerIoFaults.linkError = linkError;
    markerIoFaults.cleanupError = new Error('cleanup failed');

    expect(() => writeMarkerExclusive(dir, { project: 'P0042' })).toThrow(linkError);
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });
});

describe('unsafe marker directories (tmpdir / filesystem root)', () => {
  const MARKER = { project: 'P0001' };
  let fakeTmp: string;
  const origTmpdir = process.env.TMPDIR;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    fakeTmp = fs.mkdtempSync(path.join(TEST_ROOT, 'fake-tmp-'));
    process.env.TMPDIR = fakeTmp;
  });

  afterEach(() => {
    if (origTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = origTmpdir;
    fs.rmSync(fakeTmp, { recursive: true, force: true });
  });

  it('isUnsafeMarkerDir flags tmpdir and root, not tmpdir subdirs', () => {
    expect(isUnsafeMarkerDir(fakeTmp)).toBe(true);
    expect(isUnsafeMarkerDir('/')).toBe(true);
    expect(isUnsafeMarkerDir(path.join(fakeTmp, 'scratch'))).toBe(false);
  });

  it('writeMarker refuses tmpdir and filesystem root', () => {
    writeMarker(fakeTmp, MARKER);
    expect(fs.existsSync(path.join(fakeTmp, '.tim-project'))).toBe(false);
    expect(() => writeMarker('/', MARKER)).not.toThrow();
    expect(fs.existsSync('/.tim-project')).toBe(false);
  });

  it('findMarker walk-up skips a tmpdir marker — markerless fallback', () => {
    writeMarkerAtomic(path.join(fakeTmp, '.tim-project'), JSON.stringify({ version: 3, ...MARKER }));
    const sub = path.join(fakeTmp, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { walkUp: true, maxRoot: fakeTmp })).toBeNull();
    expect(detectProject(fakeTmp)).toBeNull();
  });

  it('walk-up still finds a legit marker in a tmpdir subdirectory', () => {
    writeMarkerAtomic(path.join(fakeTmp, '.tim-project'), JSON.stringify({ version: 3, ...MARKER }));
    const proj = path.join(fakeTmp, 'proj');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    writeMarkerAtomic(path.join(proj, '.tim-project'), JSON.stringify({ version: 3, project: 'P0002' }));
    const found = findMarker(path.join(proj, 'src'), { walkUp: true, maxRoot: fakeTmp });
    expect(found?.marker.project).toBe('P0002');
    expect(found?.dir).toBe(proj);
  });
});
