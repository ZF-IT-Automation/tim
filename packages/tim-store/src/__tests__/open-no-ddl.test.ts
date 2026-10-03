import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from '../store.js';

// Every DDL statement bumps the schema cookie and invalidates the prepared
// statements of every other connection. Hooks open a store per prompt, so an
// open that rewrote triggers pushed the live cookie past 557,000 (~70k opens).
describe('TimStore open on an up-to-date database', () => {
  let root: string;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  const cookie = (s: TimStore) => s.getDb().pragma('schema_version', { simple: true }) as number;
  const triggerSql = (s: TimStore) => s.getDb().prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all();

  it('leaves the schema untouched', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-noddl-'));
    const dbPath = path.join(root, 'tim.db');
    const first = new TimStore(dbPath, { staging: true });
    const before = cookie(first);
    const triggers = triggerSql(first);
    first.close();

    const second = new TimStore(dbPath, { staging: true });
    expect(cookie(second)).toBe(before);
    expect(triggerSql(second)).toEqual(triggers);
    second.close();
  });

  it('restores a missing or altered trigger and drops legacy ones', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-noddl-'));
    const dbPath = path.join(root, 'tim.db');
    const first = new TimStore(dbPath, { staging: true });
    const triggers = triggerSql(first);
    first.getDb().exec(`
      DROP TRIGGER entries_ai;
      DROP TRIGGER entries_au;
      CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN SELECT 1; END;
      CREATE TRIGGER entries_au_del AFTER DELETE ON entries BEGIN SELECT 1; END;
    `);
    first.close();

    const second = new TimStore(dbPath, { staging: true });
    expect(triggerSql(second)).toEqual(triggers);
    second.close();
  });
});
