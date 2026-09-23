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

  it('does not count harness-only user turns; merges agent onto previous exchange', async () => {
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
});
