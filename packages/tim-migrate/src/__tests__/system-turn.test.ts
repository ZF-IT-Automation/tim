import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TimStore,
  SessionManager,
  findChildByKind,
  KIND_EXCHANGE,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGES_ROOT,
} from 'tim-store';
import { migrateSystemTurn } from '../system-turn.js';

const LIVE_TASK_NOTIFICATION =
  '<task-notification><status>completed</status><summary>done</summary></task-notification>';

describe('migrateSystemTurn', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-migrate-system-turn-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dry-run counts harness-only legacy exchanges per project without writing', async () => {
    await store.createProject('P0100', { content: 'migrate test' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'legacy-s',
      projectId: 'P0100',
      agentName: 'a',
      cwd: '/tmp',
      harness: 't',
    });
    // Simulate pre-08cb814 storage: harness-only text without metadata.system_turn.
    const exRoot = await findChildByKind(store, 'legacy-s', KIND_EXCHANGES_ROOT);
    const batch = store.writeSync('Batch 0', {
      parentId: exRoot!.id,
      metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: 0, order: 0 },
    });
    store.writeSync(LIVE_TASK_NOTIFICATION, {
      parentId: batch.id,
      metadata: { kind: KIND_EXCHANGE, role: 'user', seq: 1, sessionId: 'legacy-s' },
    });

    const dry = await migrateSystemTurn(store, { dryRun: true });
    expect(dry.flagged).toBe(1);
    expect(dry.byProject).toEqual([{ projectId: expect.any(String), label: 'P0100', flagged: 1 }]);

    const flaggedBefore = (store.getDb() as any)
      .prepare("SELECT count(*) c FROM entries WHERE json_extract(metadata,'$.system_turn')=1")
      .get().c;
    expect(flaggedBefore).toBe(0);

    const live = await migrateSystemTurn(store, { dryRun: false });
    expect(live.flagged).toBe(1);
    const flaggedAfter = (store.getDb() as any)
      .prepare("SELECT count(*) c FROM entries WHERE json_extract(metadata,'$.system_turn')=1")
      .get().c;
    expect(flaggedAfter).toBe(1);

    const again = await migrateSystemTurn(store, { dryRun: false });
    expect(again.flagged).toBe(0);
    expect(again.skippedAlreadyFlagged).toBe(1);
  });
});
