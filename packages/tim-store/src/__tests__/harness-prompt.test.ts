import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TimStore,
  SessionManager,
  deriveCounters,
  isHarnessOnlyPrompt,
  stripHarnessBlocks,
  sanitizeUserExchangeContent,
} from '../index.js';

/** Shape copied from live preview.txt "Since the last summary" block. */
const LIVE_TASK_NOTIFICATION =
  '<task-notification> <task-id>bdwc41qpu</task-id> <tool-use-id>toolu_01HgBBfKV5uS1wPQpobC6nPw</tool-use-id> ' +
  '<output-file>/tmp/claude-1000/-home-bbbee-projects-tim/d478431c-bb0b-4cd6-ad12-873ac2eebf01/tasks/bdwc41qpu.output</output-file> ' +
  '<status>completed</status> <summary>Background command completed</summary></task-notification>';

describe('harness-prompt', () => {
  it('detects live-shaped task-notification as harness-only', () => {
    expect(isHarnessOnlyPrompt(LIVE_TASK_NOTIFICATION)).toBe(true);
    expect(stripHarnessBlocks(LIVE_TASK_NOTIFICATION)).toBe('');
  });

  it('strips harness blocks but keeps human text', () => {
    const mixed = `${LIVE_TASK_NOTIFICATION}\n\nReview das Projekt bitte.`;
    expect(stripHarnessBlocks(mixed)).toBe('Review das Projekt bitte.');
    expect(sanitizeUserExchangeContent(mixed).systemTurn).toBe(false);
  });

  it('treats system-reminder-only prompts as harness-only', () => {
    const raw = '<system-reminder>hooks are installed</system-reminder>';
    expect(sanitizeUserExchangeContent(raw)).toEqual({ content: '', systemTurn: true });
  });
});

describe('logExchange harness filtering', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `tim-harness-${crypto.randomBytes(8).toString('hex')}.db`);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('does not count harness-only user turns', async () => {
    const store = new TimStore(dbPath);
    const project = await store.createProject('P0099', { content: 'harness test' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({
      sessionId: 'harness-s',
      projectId: project.metadata.label ?? 'P0099',
      agentName: 'a',
      cwd: '/tmp',
      harness: 't',
    });
    await sessions.logExchange('harness-s', [
      { role: 'user', content: 'Review das Projekt' },
      { role: 'agent', content: 'Ok, schaue ich an.' },
    ]);
    await sessions.logExchange('harness-s', [
      { role: 'user', content: LIVE_TASK_NOTIFICATION },
      { role: 'agent', content: 'C7 ist vorbereitet.' },
    ]);
    expect((await deriveCounters(store, 'harness-s')).exchangeCount).toBe(1);
    store.close();
  });

  it('stores human text verbatim, including newlines and text after an unclosed tag', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0098', { content: 'verbatim' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({ sessionId: 'v-s', projectId: 'P0098', agentName: 'a', cwd: '/tmp', harness: 't' });
    const human = 'Zeile eins\n\n  eingerückt\nIch schreibe <system-reminder> ohne Ende und dann mehr Text';
    const written = await sessions.logExchange('v-s', [
      { role: 'user', content: human },
      { role: 'agent', content: 'ok' },
    ]);
    const user = written.find(e => e.metadata.role === 'user');
    // writeSync stores the first line as title (pre-existing); the rest is the body.
    expect(user?.title).toBe('Zeile eins');
    expect(user?.content).toContain('eingerückt\nIch schreibe <system-reminder> ohne Ende und dann mehr Text');
    expect(user?.metadata.system_turn).toBeUndefined();
    store.close();
  });

  it('flags a harness-only turn and replays it idempotently', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0097', { content: 'replay' });
    const sessions = new SessionManager(store);
    await sessions.startProjectSession({ sessionId: 'r-s', projectId: 'P0097', agentName: 'a', cwd: '/tmp', harness: 't' });
    const turn = [
      { role: 'user' as const, content: LIVE_TASK_NOTIFICATION },
      { role: 'agent' as const, content: 'C7 ist vorbereitet.' },
    ];
    await sessions.logExchangeOnce('r-s', 'k1', turn);
    await sessions.logExchangeOnce('r-s', 'k1', turn);
    const agentCount = (store.db as any)
      .prepare("SELECT count(*) c FROM entries WHERE json_extract(metadata,'$.sessionId')='r-s' AND json_extract(metadata,'$.role')='agent'")
      .get().c;
    expect(agentCount).toBe(1);
    const flagged = (store.db as any)
      .prepare("SELECT count(*) c FROM entries WHERE json_extract(metadata,'$.sessionId')='r-s' AND json_extract(metadata,'$.system_turn')=1")
      .get().c;
    expect(flagged).toBe(1);
    expect((await deriveCounters(store, 'r-s')).exchangeCount).toBe(0);
    store.close();
  });
});
