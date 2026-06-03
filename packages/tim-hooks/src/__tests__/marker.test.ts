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
      project: 'P1',
      session: 's1',
      exchanges: 3,
      batch_size: 5,
      batches_summarized: 0,
    });
    expect(readMarker(dir)).toMatchObject({ project: 'P1', session: 's1', exchanges: 3 });
  });

  it('detectProject prefers the .tim-project marker', () => {
    writeMarker(dir, {
      project: 'P9',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    expect(detectProject(dir)?.project).toBe('P9');
  });

  it('detectProject returns null when no marker exists', () => {
    expect(detectProject(dir)).toBeNull();
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
    writeMarker(dir, { project: 'P1', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const found = findMarker(dir, { maxRoot: dir });
    expect(found?.marker.project).toBe('P1');
    expect(found?.dir).toBe(fs.realpathSync(dir));
  });

  it('findMarker walks up to a parent marker', () => {
    writeMarker(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir })?.marker.project).toBe('PARENT');
  });

  it('findMarker: nearest marker wins over an ancestor', () => {
    writeMarker(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(sub, { project: 'CHILD', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    expect(findMarker(sub, { maxRoot: dir })?.marker.project).toBe('CHILD');
  });

  it('findMarker: repo marker wins over ~/.tim-project on the same walk chain', () => {
    const fakeHome = path.join(dir, 'fake-home');
    const repo = path.join(fakeHome, 'projects', 'tim');
    const sub = path.join(repo, 'packages');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(fakeHome, {
      project: 'HOME',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    writeMarker(repo, {
      project: 'REPO',
      session: 's',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    const found = findMarker(sub, { maxRoot: fakeHome });
    expect(found?.marker.project).toBe('REPO');
    expect(found?.dir).toBe(fs.realpathSync(repo));
  });

  it('findMarker returns null when no marker exists up to root (no infinite loop)', () => {
    const sub = path.join(dir, 'x', 'y');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub, { maxRoot: dir })).toBeNull();
  });

  it('findMarker stops at a corrupt nearest marker (does not silently use an ancestor)', () => {
    writeMarker(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.tim-project'), '{ not valid json');
    expect(findMarker(sub, { maxRoot: dir })).toBeNull();
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
