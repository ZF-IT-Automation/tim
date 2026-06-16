import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  readMarker,
  writeMarker,
  detectProject,
  findMarker,
  syncNearestProjectMarker,
  buildLoadDirective,
  reconcileMarker,
  acquireLock,
  releaseLock,
  validateMarkerAgainstStore,
  INBOX_LABEL,
} from '../marker.js';
import { TimStore, SessionManager } from 'tim-store';

/** Outside ~ so findMarker walk-up does not hit real ~/.tim-project */
const TEST_ROOT = '/tmp/tim-test-runs';

describe('marker', () => {
  let dir: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'marker-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a marker file', () => {
    writeMarker(dir, {
      project: 'P0001',
      session: 's1',
      exchanges: 3,
      batch_size: 5,
      batches_summarized: 0,
    });
    expect(readMarker(dir)).toMatchObject({ project: 'P0001', session: 's1', exchanges: 3 });
  });

  it('detectProject prefers the .tim-project marker', () => {
    writeMarker(dir, {
      project: 'P0009',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    expect(detectProject(dir)?.project).toBe('P0009');
  });

  it('detectProject returns null when no marker exists', () => {
    expect(detectProject(dir)).toBeNull();
  });

  it('readMarker falls back to tim.json when no .tim-project exists', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0063' }));
    expect(readMarker(dir)?.project).toBe('P0063');
    expect(readMarker(dir)?.exchanges).toBe(0);
  });

  it('readMarker prefers .tim-project over tim.json', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0062' }));
    writeMarker(dir, {
      project: 'P0063',
      session: 's',
      exchanges: 1,
      batch_size: 5,
      batches_summarized: 0,
    });
    expect(readMarker(dir)?.project).toBe('P0063');
  });

  it('findMarker walks up to parent tim.json when no .tim-project exists', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0063' }));
    const sub = path.join(dir, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })?.marker.project).toBe('P0063');
  });

  it('reconcileMarker overwrites cached counters with DB-derived values', async () => {
    const store = new TimStore(':memory:');
    const sessions = new SessionManager(store);
    await store.createProject('P0002');
    await sessions.startProjectSession({
      sessionId: 'sm',
      projectId: 'P0002',
      agentName: 'a',
      cwd: dir,
      harness: 't',
      batchSize: 2,
    });
    await sessions.logExchange('sm', [
      { role: 'user', content: 'q' },
      { role: 'agent', content: 'a' },
    ]);
    writeMarker(dir, {
      project: 'P0002',
      session: 'sm',
      exchanges: 99,
      batch_size: 2,
      batches_summarized: 7,
    });

    const reconciled = await reconcileMarker(store, dir);
    expect(reconciled.exchanges).toBe(1);
    expect(reconciled.batches_summarized).toBe(0);
    store.close();
  });

  it('acquireLock single-flights: second acquire fails while the lock is fresh', () => {
    expect(acquireLock(dir)).toBe(true);
    expect(acquireLock(dir)).toBe(false);
    releaseLock(dir);
    expect(acquireLock(dir)).toBe(true);
  });

  it('findMarker returns the marker in the cwd itself', () => {
    writeMarker(dir, { project: 'P0001', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const found = findMarker(dir, { maxRoot: dir });
    expect(found?.marker.project).toBe('P0001');
    expect(found?.dir).toBe(fs.realpathSync(dir));
  });

  it('findMarker walks up to a parent marker', () => {
    writeMarker(dir, { project: 'P0002', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })?.marker.project).toBe('P0002');
  });

  it('findMarker: nearest marker wins over an ancestor', () => {
    writeMarker(dir, { project: 'P0002', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(sub, { project: 'P0003', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })?.marker.project).toBe('P0003');
  });

  it('findMarker: repo marker wins over ~/.tim-project on the same walk chain', () => {
    const fakeHome = path.join(dir, 'fake-home');
    const repo = path.join(fakeHome, 'projects', 'tim');
    const sub = path.join(repo, 'packages');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(fakeHome, {
      project: 'P0099',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    writeMarker(repo, {
      project: 'P0063',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
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
    writeMarker(dir, { project: 'P0002', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.tim-project'), '{ not valid json');
    expect(findMarker(sub, { maxRoot: dir, walkUp: true })).toBeNull();
  });

  it('findMarker returns null for parent marker when walkUp is not set (cwd-only default)', () => {
    writeMarker(dir, { project: 'P0002', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub)).toBeNull();
  });

  it('findMarker returns cwd marker without walkUp option', () => {
    writeMarker(dir, { project: 'P0001', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
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
      writeMarker(homeDir, {
        project: 'P0099',
        session: 's',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      });
      const sub = path.join(homeDir, 'projects', 'repo');
      fs.mkdirSync(sub, { recursive: true });
      expect(findMarker(sub, { maxRoot: homeDir, walkUp: true, allowHome: false })).toBeNull();
    });

    it('returns home ancestor when allowHome is true', () => {
      writeMarker(homeDir, {
        project: 'P0099',
        session: 's',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      });
      const sub = path.join(homeDir, 'projects', 'repo');
      fs.mkdirSync(sub, { recursive: true });
      expect(findMarker(sub, { maxRoot: homeDir, walkUp: true, allowHome: true })?.marker.project).toBe(
        'P0099',
      );
    });

    it('returns home marker when cwd is home even if allowHome is false', () => {
      writeMarker(homeDir, {
        project: 'P0099',
        session: 's',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      });
      expect(findMarker(homeDir, { walkUp: true, allowHome: false })?.marker.project).toBe('P0099');
    });
  });

  // Regression: a hand-edited or stale .tim-project with a malformed
  // project label (e.g. "notalabel", "12345", or wrong digit count)
  // must not be treated as authoritative. The original bug was a P9999
  // label silently binding the session to a non-existent project
  // (TIM's Inbox-fallback is P0000, never P9999). The new whitelist
  // rejects any label that doesn't match the canonical ^[PLEN]\d{4}$
  // shape so the resolution chain falls back to ~/.tim/active-project
  // or INBOX_PROJECT_LABEL (P0000).
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
    // findMarker must reject the corrupt nearest marker — same
    // contract as for unparseable JSON.
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
    writeMarker(dir, {
      project: 'P0062',
      session: 'bg_old',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    const sub = path.join(dir, 'repo');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(sub, {
      project: 'P0062',
      session: 'bg_old',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });

    expect(
      syncNearestProjectMarker(sub, 'P0063', {
        sessionId: '20260602_155620_ee0929',
        findOptions: { maxRoot: dir },
      }),
    ).toBe(true);
    expect(readMarker(sub)?.project).toBe('P0063');
    expect(readMarker(sub)?.session).toBe('20260602_155620_ee0929');
    expect(readMarker(dir)?.project).toBe('P0062');
  });
});

describe('marker v2 schema', () => {
  let dir: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'marker-v2-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeMarker stamps the current version on disk', () => {
    writeMarker(dir, {
      project: 'P0001',
      session: 's1',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'),
    );
    expect(onDisk.version).toBe(2);
  });

  it('readMarker returns the v2 shape (with version: 2)', () => {
    writeMarker(dir, {
      project: 'P0001',
      session: 's1',
      exchanges: 3,
      batch_size: 5,
      batches_summarized: 1,
    });
    const m = readMarker(dir);
    expect(m?.version).toBe(2);
    expect(m?.project).toBe('P0001');
    expect(m?.session).toBe('s1');
    expect(m?.exchanges).toBe(3);
    expect(m?.batch_size).toBe(5);
    expect(m?.batches_summarized).toBe(1);
  });

  it('readMarker auto-upgrades a v1 file (no version field) to v2 in memory', () => {
    // Hand-write a v1 file on disk — no `version` field, plus legacy cruft.
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

    const m = readMarker(dir);
    expect(m).toEqual({
      version: 2,
      project: 'P0062',
      session: 'bg',
      exchanges: 42,
      batch_size: 5,
      batches_summarized: 2,
    });
  });

  it('readMarker does NOT rewrite the v1 file on read (auto-upgrade happens on next write)', () => {
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

    readMarker(dir); // should not touch the file

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'),
    );
    expect(onDisk.version).toBeUndefined();
    expect(onDisk.route_exchanges_to).toBe('P0063');
  });

  it('the first write to a v1 file upgrades it to v2 on disk', () => {
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

    writeMarker(dir, {
      project: 'P0062',
      session: 'bg',
      exchanges: 50,
      batch_size: 5,
      batches_summarized: 2,
    });

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'),
    );
    expect(onDisk.version).toBe(2);
    expect(onDisk.exchanges).toBe(50);
    expect(onDisk.route_exchanges_to).toBeUndefined();
    expect(onDisk.sessions).toBeUndefined();
  });

  it('readMarker strips legacy fields even if version is 1 (corrupt-ish v1)', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        version: 1,
        project: 'P0001',
        session: 's',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
        route_exchanges_to: 'X',
        sessions: { X: 'y' },
      }, null, 2),
    );
    const m = readMarker(dir);
    expect(m?.version).toBe(2);
    expect(m).not.toHaveProperty('route_exchanges_to');
    expect(m).not.toHaveProperty('sessions');
  });

  it('readMarker returns null for a marker missing required numeric fields', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: 'P0001',
        session: 's',
        // exchanges missing
        batch_size: 5,
        batches_summarized: 0,
      }, null, 2),
    );
    expect(readMarker(dir)).toBeNull();
  });

  it('readMarker returns null for a marker with non-numeric counters', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        project: 'P0001',
        session: 's',
        exchanges: 'not a number',
        batch_size: 5,
        batches_summarized: 0,
      }, null, 2),
    );
    expect(readMarker(dir)).toBeNull();
  });

  it('ProjectMarkerInput accepts a marker without version (writer fills it in)', () => {
    // Type-level test: this line must compile.
    const input: Parameters<typeof writeMarker>[1] = {
      project: 'P0001',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    };
    writeMarker(dir, input);
    expect(readMarker(dir)?.version).toBe(2);
  });
});

// ─── DB-existence validation (P9999 defense-in-depth) ────────────────────
//
// The pattern check in normalizeMarker catches "P9", "P", "notalabel",
// etc. — but a label like "P9999" matches the pattern yet never
// corresponds to a real TIM project. The P9999 bug bound the statusline
// to a non-existent project because the on-disk marker was trusted.
// `validateMarkerAgainstStore` closes that gap: the marker is only
// accepted when the project label resolves to a real entry in the DB.
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
    const bogus = {
      version: 2 as const,
      project: 'P9999',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    };
    expect(await validateMarkerAgainstStore(bogus, store)).toBeNull();
  });

  it('accepts a label that resolves to a real project, returning the canonical form', async () => {
    await store.createProject('P0062');
    const ok = {
      version: 2 as const,
      project: 'P0062',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    };
    const validated = await validateMarkerAgainstStore(ok, store);
    expect(validated?.project).toBe('P0062');
  });

  it('accepts the Inbox (P0000) even when it is not yet materialized in the DB', async () => {
    // P0000 is exempt: tim-store.ensureInboxProject() creates it lazily,
    // and session-start should never block on that materialization just
    // to validate a marker.
    const inbox = {
      version: 2 as const,
      project: INBOX_LABEL,
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    };
    const validated = await validateMarkerAgainstStore(inbox, store);
    expect(validated?.project).toBe('P0000');
  });

  it('fails open (accepts) when the DB lookup itself throws — pattern check still gates', async () => {
    const ok = {
      version: 2 as const,
      project: 'P0062',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    };
    const broken = {
      resolveProjectLabel: () => {
        throw new Error('db locked');
      },
    } as unknown as Pick<TimStore, 'resolveProjectLabel'>;
    // The marker is returned unchanged — we never reject a label that
    // already passed the pattern check just because the DB is briefly
    // unavailable. The pattern check is the strict gate; the DB
    // existence check is the soft gate.
    expect(await validateMarkerAgainstStore(ok, broken)).toEqual(ok);
  });
});
