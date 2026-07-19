import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, upsertProjectPathRow } from 'tim-store';
import {
  bindUnboundBindings,
  classifyProjectPathBinding,
  writeMarkerExclusive,
} from 'tim-hooks';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = '/tmp/tim-test-runs';

function run(args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function snapshotTree(root: string): Record<string, string> {
  const snap: Record<string, string> = {};
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else {
        snap[p] = fs.readFileSync(p, 'utf8');
      }
    }
  }
  walk(root);
  return snap;
}

describe('tim doctor bindings', () => {
  let root: string;
  let dbPath: string;
  let store: TimStore;
  let dirA: string;
  let dirB: string;
  let dirStale: string;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TEST_ROOT, 'doctor-bind-'));
    dbPath = path.join(root, 'tim.db');
    dirA = path.join(root, 'project-a');
    dirB = path.join(root, 'project-b');
    dirStale = path.join(root, 'stale-path');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.mkdirSync(dirStale);

    store = new TimStore(dbPath);
    await store.createProject('P7001', { metadata: { path: dirA } });
    await store.createProject('P7002', { metadata: { path: dirB } });
    await store.createProject('P7003', { metadata: { path: path.join(root, 'missing') } });
    await store.createProject('P7004');
    await store.createProject('P7005', { metadata: { path: dirStale } });

    fs.writeFileSync(
      path.join(dirB, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P7999' }),
    );

    const staleDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await upsertProjectPathRow(store, 'P7005', os.hostname(), dirStale);
    const rows = await store.getChildByKind((await store.requireProject('P7005')).id, 'project-path');
    await store.update(rows[0].id, {
      metadata: { ...rows[0].metadata, last_seen_at: staleDate },
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const env = () => ({ TIM_DB_PATH: dbPath });

  it('classifies fixture projects', () => {
    expect(classifyProjectPathBinding('P7001', dirA)).toEqual({ status: 'unbound' });
    expect(classifyProjectPathBinding('P7002', dirB)).toEqual({
      status: 'label-mismatch',
      markerLabel: 'P7999',
    });
    expect(classifyProjectPathBinding('P7003', path.join(root, 'missing'))).toEqual({
      status: 'path-missing',
    });
    expect(classifyProjectPathBinding('P7004', undefined)).toEqual({ status: 'no-path' });
  });

  it('reports binding findings without filesystem writes', () => {
    store.close();
    const fixtureDirs = [dirA, dirB, dirStale];
    const before = Object.assign({}, ...fixtureDirs.map(d => snapshotTree(d)));
    const out = run(['doctor'], env());
    const after = Object.assign({}, ...fixtureDirs.map(d => snapshotTree(d)));

    expect(out).toContain('Bindings:');
    expect(out).toContain('P7001');
    expect(out).toContain(`${dirA} unbound`);
    expect(out).toContain('P7002');
    expect(out).toContain('label-mismatch');
    expect(out).toContain('P7999');
    expect(out).toContain('P7003');
    expect(out).toContain('path-missing');
    expect(out).toContain('P7004 no-path');
    expect(out).toContain('stale P7005');
    expect(out).toContain(dirStale);
    expect(before).toEqual(after);
  });

  it('binds unbound projects with --bind and leaves other findings untouched', () => {
    store.close();
    const markerB = fs.readFileSync(path.join(dirB, '.tim-project'), 'utf8');

    const bindOut = run(['doctor', '--bind'], env());
    expect(bindOut).toContain('Bind:');
    expect(bindOut).toContain('P7001: bound');
    expect(fs.existsSync(path.join(dirA, '.tim-project'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dirA, '.tim-project'), 'utf8')).project).toBe('P7001');
    expect(fs.readFileSync(path.join(dirB, '.tim-project'), 'utf8')).toBe(markerB);
    expect(fs.existsSync(path.join(root, 'missing', '.tim-project'))).toBe(false);

    const rerun = run(['doctor'], env());
    expect(rerun).toContain(`${dirA} bound`);
    expect(rerun).toContain('label-mismatch');
    expect(rerun).toContain('path-missing');
    expect(rerun).toContain('P7004 no-path');
  });

  it('does not clobber a marker that wins during bind recovery', async () => {
    const lateWinner = () => {
      writeMarkerExclusive(dirA, { project: 'P7998' });
      return writeMarkerExclusive(dirA, { project: 'P7001' });
    };

    const findings = [{ label: 'P7001', path: dirA, status: 'unbound' as const }];
    const outcomes = await bindUnboundBindings(store, findings, { writeExclusive: lateWinner });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe('failed');
    expect(JSON.parse(fs.readFileSync(path.join(dirA, '.tim-project'), 'utf8')).project).toBe('P7998');
  });
});
