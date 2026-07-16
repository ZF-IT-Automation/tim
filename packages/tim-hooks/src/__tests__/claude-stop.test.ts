import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore, SessionManager, deriveCounters } from 'tim-store';
import { writeMarker } from '../marker.js';
import { runClaudeStop, type ClaudeStopPayload } from '../claude-stop.js';

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

function writeTranscript(dir: string, lines: unknown[]): string {
  const file = path.join(dir, 'transcript.jsonl');
  const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n';
  fs.writeFileSync(file, body);
  return file;
}

function userMsg(uuid: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content },
    ...extra,
  };
}

function assistantMsg(uuid: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content },
    ...extra,
  };
}

describe('runClaudeStop', () => {
  let root: string;
  let cwd: string;
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-claude-stop-'));
    cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd);
    store = new TimStore(path.join(root, 'tim.db'));
    sessions = new SessionManager(store);
    await store.createProject('P9001', { content: 'Claude stop project' });
    writeMarker(cwd, {
      project: 'P9001',
      session: 'claude-stop-sess',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function payload(overrides: Partial<ClaudeStopPayload> = {}): ClaudeStopPayload {
    return {
      session_id: 'claude-stop-sess',
      transcript_path: path.join(cwd, 'transcript.jsonl'),
      cwd,
      ...overrides,
    };
  }

  it('logs the last string/content-block exchange and is idempotent on duplicate Stop', async () => {
    const transcript = writeTranscript(cwd, [
      userMsg('u0', 'earlier'),
      assistantMsg('a0', [{ type: 'text', text: 'earlier reply' }]),
      userMsg('u1', 'final user Größe'),
      assistantMsg('a1', [{ type: 'text', text: 'final agent Antwort' }]),
    ]);

    const p = payload({ transcript_path: transcript });
    const first = await runClaudeStop(store, p, { cwd });
    const second = await runClaudeStop(store, p, { cwd });

    expect(first.logged).toBe(true);
    expect(second).toMatchObject({ logged: false, duplicate: true });
    expect((await deriveCounters(store, p.session_id)).exchangeCount).toBe(1);

    const session = await store.read(p.session_id);
    expect(session?.metadata.kind).toBe('session');
  });

  it('skips isMeta and tool-only assistant turns when selecting the last exchange', async () => {
    writeTranscript(cwd, [
      userMsg('meta-u', [{ type: 'text', text: 'skill preamble' }], { isMeta: true }),
      assistantMsg('tool-a', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      userMsg('real-u', 'real question'),
      assistantMsg('real-a', [{ type: 'text', text: 'real answer' }]),
      userMsg('meta-u2', 'ignore me', { isMeta: true }),
      assistantMsg('tool-a2', [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
    ]);

    const result = await runClaudeStop(store, payload(), { cwd });
    expect(result.logged).toBe(true);
    expect(result.exchangeCount).toBe(1);

    const logged = await sessions.showUnsummarized('claude-stop-sess');
    const texts = logged.exchanges.flatMap((ex) => [ex.userContent, ex.agentContent ?? '']);
    expect(texts.join('\n')).toContain('real question');
    expect(texts.join('\n')).toContain('real answer');
    expect(texts.join('\n')).not.toContain('skill preamble');
  });

  it('ignores malformed JSONL lines and returns not-logged when no turn exists', async () => {
    writeTranscript(cwd, [
      'not-json',
      '{broken',
      userMsg('u1', 'orphan user without assistant'),
    ]);

    const result = await runClaudeStop(store, payload(), { cwd });
    expect(result).toEqual({ logged: false });
    expect((await deriveCounters(store, 'claude-stop-sess')).exchangeCount).toBe(0);
  });

  it('starts a missing session from the cwd-local marker then logs', async () => {
    writeTranscript(cwd, [
      userMsg('u1', 'hello missing session'),
      assistantMsg('a1', 'started ok'),
    ]);

    expect(await store.read('claude-stop-sess')).toBeNull();
    const result = await runClaudeStop(store, payload(), { cwd });
    expect(result.logged).toBe(true);
    expect((await store.read('claude-stop-sess'))?.metadata.harness).toBe('claude-code');
  });

  it('returns not-logged when transcript exceeds 1 MiB', async () => {
    const huge = 'x'.repeat(MAX_TRANSCRIPT_BYTES + 1);
    const file = path.join(cwd, 'huge.jsonl');
    fs.writeFileSync(file, huge);
    const result = await runClaudeStop(store, payload({ transcript_path: file }), { cwd });
    expect(result).toEqual({ logged: false });
  });

  it('produces counters 1-5 and exactly one configured checkpoint across five distinct exchanges', async () => {
    const configDir = path.join(root, 'home', '.tim');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      checkpoint: { everyN: 5 },
    }));
    const prevHome = process.env.HOME;
    process.env.HOME = path.join(root, 'home');

    try {
      for (let i = 1; i <= 5; i++) {
        writeTranscript(cwd, [
          userMsg(`u${i}`, `question ${i}`),
          assistantMsg(`a${i}`, `answer ${i}`),
        ]);
        const result = await runClaudeStop(store, payload({ session_id: 'claude-stop-sess' }), { cwd });
        expect(result.logged).toBe(true);
        expect(result.exchangeCount).toBe(i);
        if (i < 5) expect(result.autoCheckpoint).toBeFalsy();
        else expect(result.autoCheckpoint).toBe(true);
      }

      expect((await deriveCounters(store, 'claude-stop-sess')).exchangeCount).toBe(5);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
