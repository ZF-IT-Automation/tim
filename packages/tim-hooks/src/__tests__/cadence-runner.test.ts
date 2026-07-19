import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TimStore, SessionManager } from 'tim-store';
import { afterExchangeLogged } from '../cadence-runner.js';
import { writeMarker } from '../marker.js';

const TEST_ROOT = path.join('/home/bbbee', '.tim-test-runs');

describe('afterExchangeLogged', () => {
  let dir: string;
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'cadence-run-'));
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0055');
    await sessions.startProjectSession({
      sessionId: 'cad-run',
      projectId: 'P0055',
      agentName: 'a',
      cwd: dir,
      harness: 't',
      batchSize: 5,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns DB-derived counts without a marker present', async () => {
    await sessions.logExchange('cad-run', [
      { role: 'user', content: 'q' },
      { role: 'agent', content: 'a' },
    ]);
    const res = await afterExchangeLogged(store, 'cad-run', dir);
    expect(res.exchangeCount).toBe(1);
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('returns DB-derived counts with a marker present and does not write files', async () => {
    writeMarker(dir, { project: 'P0055' });
    const markerPath = path.join(dir, '.tim-project');
    const before = fs.readFileSync(markerPath);
    const mtimeBefore = fs.statSync(markerPath).mtimeMs;

    await sessions.logExchange('cad-run', [
      { role: 'user', content: 'q' },
      { role: 'agent', content: 'a' },
    ]);
    const res = await afterExchangeLogged(store, 'cad-run', dir);

    expect(res.exchangeCount).toBe(1);
    expect(fs.readFileSync(markerPath).equals(before)).toBe(true);
    expect(fs.statSync(markerPath).mtimeMs).toBe(mtimeBefore);
  });
});
