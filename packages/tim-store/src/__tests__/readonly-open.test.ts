import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from '../store.js';

describe('TimStore readonly open', () => {
  const origHome = process.env.HOME;
  let root: string;

  afterEach(() => {
    process.env.HOME = origHome;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not migrate, install the staging-off trigger, or delete old acked rows', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-ro-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.tim'), { recursive: true });
    process.env.HOME = home;
    fs.writeFileSync(
      path.join(home, '.tim', 'config.json'),
      JSON.stringify({ sync: { staging: false } }),
    );
    const dbPath = path.join(root, 'tim.db');
    const created = new TimStore(dbPath, { staging: true });
    created.getDb().prepare(
      `INSERT INTO staging (key, entity_type, operation, payload, lww_timestamp, lww_device, lww_confidence, acked)
       VALUES ('old-acked', 'entry', 'upsert', '{}', 1, 'local', 1, 1)`,
    ).run();
    const beforeVersion = (created.getDb().prepare(
      'SELECT version FROM _schema_version',
    ).get() as { version: number }).version;
    const beforeTriggers = created.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all();
    created.close();

    const readonly = new TimStore(dbPath, { readonly: true });
    expect(readonly.getDb().prepare(
      'SELECT key FROM staging WHERE key = ?',
    ).get('old-acked')).toEqual({ key: 'old-acked' });
    expect((readonly.getDb().prepare(
      'SELECT version FROM _schema_version',
    ).get() as { version: number }).version).toBe(beforeVersion);
    expect(readonly.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all()).toEqual(beforeTriggers);
    expect(readonly.getDb().prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'staging_disabled'",
    ).get()).toBeUndefined();
    expect(readonly.lastMigration).toBeNull();
    readonly.close();
  });
});
