import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');

describe('tim sync audit --json', () => {
  it('reports a disconnected placeholder without changing the database or sync files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-audit-cli-'));
    const home = path.join(root, 'home');
    const timDir = path.join(home, '.tim');
    fs.mkdirSync(timDir, { recursive: true });
    const dbPath = path.join(root, 'tim.db');
    const store = new TimStore(dbPath);
    store.getDb().prepare(
      `INSERT INTO staging (key, entity_type, operation, payload, lww_timestamp, lww_device, lww_confidence, acked)
       VALUES ('old-acked', 'entry', 'upsert', '{}', 1, 'local', 1, 1)`,
    ).run();
    store.close();

    const syncJson = JSON.stringify({
      serverUrl: '',
      userId: '',
      token: '',
      salt: '',
      fileId: '',
    });
    const syncPath = path.join(timDir, 'sync.json');
    const statePath = path.join(timDir, 'sync-state.json');
    fs.writeFileSync(syncPath, syncJson);
    fs.writeFileSync(statePath, JSON.stringify({
      fileId: 'fake-file-id',
      cursor: 'old-cursor',
      lastPush: '2026-08-12T00:00:00.000Z',
      lastPull: '2026-08-12T00:00:00.000Z',
    }));
    const syncBefore = fs.readFileSync(syncPath);
    const stateBefore = fs.readFileSync(statePath);

    const output = execFileSync('node', [CLI, 'sync', 'audit', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        TIM_DB_PATH: dbPath,
        TIM_EMBEDDING_DISABLED: '1',
      },
    });
    const report = JSON.parse(output) as {
      openedReadOnly: boolean;
      connection: { status: string; fileId: string | null };
      state: { cursorUsable: boolean; lastPushSuccess: string | null };
      queue: { bytes: number | null };
    };
    expect(report.openedReadOnly).toBe(true);
    expect(report.connection.status).toBe('disconnected');
    expect(report.connection.fileId).toBeNull();
    expect(report.state.cursorUsable).toBe(false);
    expect(report.state.lastPushSuccess).toBeNull();
    expect(report.queue.bytes).toBeNull();
    expect(output).not.toContain('old-cursor');
    expect(output).not.toContain('fake-file-id');
    expect(fs.readFileSync(syncPath)).toEqual(syncBefore);
    expect(fs.readFileSync(statePath)).toEqual(stateBefore);

    const check = new TimStore(dbPath, { readonly: true });
    expect(check.getDb().prepare('SELECT key FROM staging WHERE key = ?').get('old-acked')).toEqual({
      key: 'old-acked',
    });
    check.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});