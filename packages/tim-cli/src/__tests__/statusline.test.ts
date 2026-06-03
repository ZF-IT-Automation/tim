import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  exchangesInCurrentBatch,
  summaryIn,
  formatTimStatusLine,
  formatHermesStatus,
  formatNoProjectStatusLine,
  statuslineFromCwd,
  resolveStatuslineCwd,
  reconcileMarkerCounters,
} from '../statusline.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeMarker } from 'tim-hooks';
import { TimStore, SessionManager } from 'tim-store';

const TEST_ROOT = '/tmp/tim-test-runs';
let emptyCacheDir: string;

describe('statusline', () => {
  beforeEach(() => {
    emptyCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sl-no-cache-'));
    process.env.TIM_CACHE_DIR = emptyCacheDir;
  });

  afterEach(() => {
    delete process.env.TIM_CACHE_DIR;
    fs.rmSync(emptyCacheDir, { recursive: true, force: true });
  });
  it('formats example line with display name', () => {
    expect(
      formatTimStatusLine(
        {
          project: 'P0063',
          session: 's',
          exchanges: 3,
          batch_size: 5,
          batches_summarized: 0,
        },
        'TIM',
      ),
    ).toBe('TIM · 3/5 exchanges · summary in 2');
  });

  it('summary at batch boundary', () => {
    expect(summaryIn(5, 5)).toBe(0);
    expect(exchangesInCurrentBatch(5, 5)).toBe(5);
  });

  it('summary when no exchanges yet', () => {
    expect(summaryIn(0, 5)).toBe(5);
    expect(exchangesInCurrentBatch(0, 5)).toBe(0);
  });

  it('no project line', () => {
    expect(formatNoProjectStatusLine()).toBe('no project');
  });

  it('hermes JSON format uses display name', () => {
    expect(
      formatHermesStatus(
        {
          project: 'P0063',
          session: 's',
          exchanges: 1,
          batch_size: 5,
          batches_summarized: 0,
        },
        'TIM',
      ),
    ).toEqual({
      device: '',
      project: 'TIM',
      o_node: '',
      counter: '1/5 · Σ4',
    });
  });

  it('resolveStatuslineCwd prefers workspace.current_dir', () => {
    expect(resolveStatuslineCwd({ cwd: '/a', workspace: { current_dir: '/b' } })).toBe('/b');
  });

  it('statuslineFromCwd uses nearest marker', async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-'));
    writeMarker(dir, {
      project: 'P0099',
      session: 'sl-test-marker-only',
      exchanges: 8,
      batch_size: 5,
      batches_summarized: 1,
    });
    const sub = path.join(dir, 'nested');
    fs.mkdirSync(sub);
    const line = await statuslineFromCwd(sub, { maxRoot: dir });
    expect(line).toMatch(/ · 3\/5 exchanges · summary in 2$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('statuslineFromCwd without marker', async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-none-'));
    expect(await statuslineFromCwd(dir, { maxRoot: dir })).toBe('no project');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconciles stale marker exchanges from DB', async () => {
    const db = path.join(TEST_ROOT, `sl-reconcile-${Date.now()}.db`);
    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = db;
    process.env.TIM_CACHE_DIR = emptyCacheDir;
    const store = new TimStore(db);
    const sessions = new SessionManager(store);
    try {
      await store.createProject('P0100');
      await sessions.startProjectSession({
        sessionId: 'hermes-real',
        projectId: 'P0100',
        agentName: 't',
        cwd: '/',
        harness: 'hermes',
      });
      await sessions.logExchange('hermes-real', [{ role: 'user', content: 'one' }]);

      const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-recon-'));
      writeMarker(dir, {
        project: 'P0100',
        session: 'hermes-real',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      });

      const line = await statuslineFromCwd(dir, { maxRoot: dir });
      expect(line).toMatch(/ · 1\/5 exchanges · /);

      const reconciled = await reconcileMarkerCounters(store, {
        project: 'P0100',
        session: 'hermes-real',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      });
      expect(reconciled.exchanges).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      store.close();
      if (prevDb === undefined) delete process.env.TIM_DB_PATH;
      else process.env.TIM_DB_PATH = prevDb;
      fs.rmSync(db, { force: true });
    }
  });

  it('uses marker project even when DB session has different project_ref', async () => {
    const db = path.join(TEST_ROOT, `sl-marker-proj-${Date.now()}.db`);
    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = db;
    const store = new TimStore(db);
    const sessions = new SessionManager(store);
    try {
      await store.createProject('P0101', { content: 'other' });
      await store.createProject('P0102', { content: 'marker' });
      await sessions.startProjectSession({
        sessionId: 'marker-sess',
        projectId: 'P0101',
        agentName: 't',
        cwd: '/',
        harness: 'hermes',
      });
      await sessions.logExchange('marker-sess', [{ role: 'user', content: 'one' }]);

      const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-marker-proj-'));
      writeMarker(dir, {
        project: 'P0102',
        session: 'marker-sess',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      });

      const line = await statuslineFromCwd(dir, { maxRoot: dir });
      expect(line).toMatch(/^marker · 1\/5 exchanges · /);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      store.close();
      if (prevDb === undefined) delete process.env.TIM_DB_PATH;
      else process.env.TIM_DB_PATH = prevDb;
      fs.rmSync(db, { force: true });
    }
  });
});
