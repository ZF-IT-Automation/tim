import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TimStore } from 'tim-store';
import { resolveActiveProjectFromCwd } from '../checkpoint.js';

const TEST_ROOT = '/tmp/tim-test-runs';

describe('resolveActiveProjectFromCwd (cwd-only project binding)', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'autoload-'));
    // Use in-memory DB to avoid touching real ~/.tim/tim.db
    process.env.TIM_DB_PATH = ':memory:';
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the project label when cwd contains a .tim-project marker', async () => {
    await store.createProject('P0042');
    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
      version: 2, project: 'P0042', session: 's', exchanges: 0,
      batch_size: 5, batches_summarized: 0,
    }));
    const label = await resolveActiveProjectFromCwd(dir, store);
    expect(label).toBe('P0042');
  });

  it('returns null when cwd has no marker', async () => {
    const label = await resolveActiveProjectFromCwd(dir, store);
    expect(label).toBeNull();
  });

  it('does NOT walk up to a parent marker (cwd is a subdir of a project)', async () => {
    // .tim-project in PARENT dir
    await store.createProject('P9999');
    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
      version: 2, project: 'P9999', session: 's', exchanges: 0,
      batch_size: 5, batches_summarized: 0,
    }));
    const sub = path.join(dir, 'src', 'lib');
    fs.mkdirSync(sub, { recursive: true });
    // No marker in sub — must NOT find parent's P9999
    const label = await resolveActiveProjectFromCwd(sub, store);
    expect(label).toBeNull();
  });

  it('does NOT walk up to a parent .tim-project (cwd is subdir of an unrelated project)', async () => {
    // In a different tree entirely: outside the project, must return null
    const outside = path.join(TEST_ROOT, 'unrelated-tree');
    fs.mkdirSync(outside, { recursive: true });
    const label = await resolveActiveProjectFromCwd(outside, store);
    expect(label).toBeNull();
  });

  it('returns null when the marker references a project that does not exist in the DB', async () => {
    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
      version: 2, project: 'P404', session: 's', exchanges: 0,
      batch_size: 5, batches_summarized: 0,
    }));
    // P404 not created in DB
    const label = await resolveActiveProjectFromCwd(dir, store);
    expect(label).toBeNull();
  });
});
