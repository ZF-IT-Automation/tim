import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore, deriveCounters } from 'tim-store';
import { writeMarker } from '../marker.js';
import { parseCodexNotifyArgs, runCodexNotify, type CodexNotifyPayload } from '../codex-notify.js';

describe('runCodexNotify', () => {
  let root: string;
  let cwd: string;
  let store: TimStore;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-codex-notify-'));
    cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd);
    store = new TimStore(path.join(root, 'tim.db'));
    await store.createProject('P9002', { content: 'Codex notify project' });
    writeMarker(cwd, {
      project: 'P9002',
      session: 'codex-notify-sess',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function payload(overrides: Partial<CodexNotifyPayload> = {}): CodexNotifyPayload {
    return {
      type: 'agent-turn-complete',
      'thread-id': '019fdde4-e40a-7401-8d65-64a9525f1506',
      'turn-id': '019fdde4-e436-7403-9167-385683d036e8',
      cwd,
      'input-messages': ['Reply with exactly: hi'],
      'last-assistant-message': 'hi',
      ...overrides,
    };
  }

  it('registers the session on the rollout thread-id and dedupes on turn-id', async () => {
    const p = payload();
    const first = await runCodexNotify(store, p, { cwd });
    const second = await runCodexNotify(store, p, { cwd });

    expect(first.logged).toBe(true);
    expect(second).toMatchObject({ logged: false, duplicate: true });

    const sessionId = p['thread-id'] as string;
    expect((await deriveCounters(store, sessionId)).exchangeCount).toBe(1);
    const session = await store.read(sessionId);
    expect(session?.metadata.kind).toBe('session');
    expect(session?.metadata.harness).toBe('codex');
  });

  it('logs a second turn of the same thread separately', async () => {
    await runCodexNotify(store, payload(), { cwd });
    const next = await runCodexNotify(
      store,
      payload({ 'turn-id': 'turn-2', 'input-messages': ['and again'], 'last-assistant-message': 'ok' }),
      { cwd },
    );

    expect(next.logged).toBe(true);
    expect((await deriveCounters(store, '019fdde4-e40a-7401-8d65-64a9525f1506')).exchangeCount).toBe(2);
  });

  it('ignores payloads that are not a completed turn', async () => {
    expect(await runCodexNotify(store, payload({ type: 'other' }), { cwd })).toEqual({ logged: false });
    expect(await runCodexNotify(store, payload({ type: undefined }), { cwd })).toEqual({ logged: false });
    expect(await runCodexNotify(store, payload({ 'last-assistant-message': '  ' }), { cwd })).toEqual({ logged: false });
    expect(await runCodexNotify(store, payload({ 'input-messages': [] }), { cwd })).toEqual({ logged: false });
  });
});

describe('parseCodexNotifyArgs', () => {
  it('takes the JSON payload from the last argv element', () => {
    const json = '{"type":"agent-turn-complete","turn-id":"t1"}';
    expect(parseCodexNotifyArgs(['codex-notify', json])?.['turn-id']).toBe('t1');
    expect(parseCodexNotifyArgs(['hook', 'codex-notify', json])?.['turn-id']).toBe('t1');
  });

  it('returns null on missing or malformed payloads', () => {
    expect(parseCodexNotifyArgs(['codex-notify'])).toBeNull();
    expect(parseCodexNotifyArgs(['codex-notify', 'not json'])).toBeNull();
    expect(parseCodexNotifyArgs(['codex-notify', '[1,2]'])).toBeNull();
  });
});
