import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  exchangesInCurrentBatch,
  summaryIn,
  formatTimStatusLine,
  formatHermesStatus,
  formatNoProjectStatusLine,
  statuslineFromCwd,
  resolveStatuslineCwd,
  resolveStatuslineCounters,
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
          exchanges: 3,
          batchSize: 5,
          batchesSummarized: 0,
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
          exchanges: 1,
          batchSize: 5,
          batchesSummarized: 0,
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

  it('statuslineFromCwd uses nearest marker and DB counters', async () => {
    const db = path.join(TEST_ROOT, `sl-nearest-${Date.now()}.db`);
    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = db;
    const store = new TimStore(db);
    const sessions = new SessionManager(store);
    try {
      fs.mkdirSync(TEST_ROOT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-'));
      await store.createProject('P0099');
      await sessions.startProjectSession({
        sessionId: 'sl-test-session',
        projectId: 'P0099',
        agentName: 't',
        cwd: dir,
        harness: 'hermes',
      });
      for (let i = 0; i < 8; i++) {
        await sessions.logExchange('sl-test-session', [{ role: 'user', content: `msg ${i}` }]);
      }

      writeMarker(dir, { project: 'P0099' });
      const sub = path.join(dir, 'nested');
      fs.mkdirSync(sub);
      const line = await statuslineFromCwd(sub, { maxRoot: dir });
      expect(line).toMatch(/ · 3\/5 exchanges · summary in 2$/);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      store.close();
      if (prevDb === undefined) delete process.env.TIM_DB_PATH;
      else process.env.TIM_DB_PATH = prevDb;
      fs.rmSync(db, { force: true });
    }
  });

  it('statuslineFromCwd without marker', async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-none-'));
    expect(await statuslineFromCwd(dir, { maxRoot: dir })).toBe('no project');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('statuslineFromCwd shows 0/5 when bound but no session', async () => {
    const db = path.join(TEST_ROOT, `sl-no-session-${Date.now()}.db`);
    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = db;
    const store = new TimStore(db);
    try {
      await store.createProject('P0105', { content: 'no session yet' });

      const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-no-sess-'));
      writeMarker(dir, { project: 'P0105' });
      const line = await statuslineFromCwd(dir, { maxRoot: dir });
      expect(line).toMatch(/ · 0\/5 exchanges · summary in 5$/);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      store.close();
      if (prevDb === undefined) delete process.env.TIM_DB_PATH;
      else process.env.TIM_DB_PATH = prevDb;
      fs.rmSync(db, { force: true });
    }
  });

  it('derives counters from DB via resolveCurrentSession', async () => {
    const db = path.join(TEST_ROOT, `sl-reconcile-${Date.now()}.db`);
    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = db;
    process.env.TIM_CACHE_DIR = emptyCacheDir;
    const store = new TimStore(db);
    const sessions = new SessionManager(store);
    try {
      await store.createProject('P0100');
      const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-recon-'));
      await sessions.startProjectSession({
        sessionId: 'hermes-real',
        projectId: 'P0100',
        agentName: 't',
        cwd: dir,
        harness: 'hermes',
      });
      await sessions.logExchange('hermes-real', [{ role: 'user', content: 'one' }]);
      writeMarker(dir, { project: 'P0100' });

      const line = await statuslineFromCwd(dir, { maxRoot: dir });
      expect(line).toMatch(/ · 1\/5 exchanges · /);

      const counters = await resolveStatuslineCounters(store, 'P0100', dir);
      expect(counters.exchanges).toBe(1);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      store.close();
      if (prevDb === undefined) delete process.env.TIM_DB_PATH;
      else process.env.TIM_DB_PATH = prevDb;
      fs.rmSync(db, { force: true });
    }
  });

  it('shows unbound suffix for phantom marker not in DB', async () => {
    const db = path.join(TEST_ROOT, `sl-phantom-${Date.now()}.db`);
    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = db;
    const store = new TimStore(db);
    try {
      const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-phantom-'));
      writeMarker(dir, { project: 'P0888' });

      const line = await statuslineFromCwd(dir, { maxRoot: dir });
      expect(line).toMatch(/P0888\?/);
      expect(line).toMatch(/ · 0\/5 exchanges · /);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      store.close();
      if (prevDb === undefined) delete process.env.TIM_DB_PATH;
      else process.env.TIM_DB_PATH = prevDb;
      fs.rmSync(db, { force: true });
    }
  });

  it('uses marker project with session resolved for that project', async () => {
    const db = path.join(TEST_ROOT, `sl-marker-proj-${Date.now()}.db`);
    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = db;
    const store = new TimStore(db);
    const sessions = new SessionManager(store);
    try {
      await store.createProject('P0102', { content: 'marker' });
      const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'sl-marker-proj-'));
      await sessions.startProjectSession({
        sessionId: 'marker-sess',
        projectId: 'P0102',
        agentName: 't',
        cwd: dir,
        harness: 'hermes',
      });
      await sessions.logExchange('marker-sess', [{ role: 'user', content: 'one' }]);
      writeMarker(dir, { project: 'P0102' });

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
