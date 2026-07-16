import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { TimStore } from 'tim-store';
import { SessionManager, deriveCounters } from 'tim-store';
import { afterExchangeLogged, type CadenceResult } from './cadence-runner.js';
import { findMarker, readMarker } from './marker.js';

export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
export const MAX_EXCHANGE_CHARS = 64 * 1024;

export interface ClaudeStopPayload {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

export interface ClaudeStopResult extends Partial<CadenceResult> {
  logged: boolean;
  duplicate?: boolean;
}

interface TranscriptTurn {
  user: string;
  assistant: string;
  identity: string;
}

function bounded(text: string, max = MAX_EXCHANGE_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('');
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? content : null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
      parts.push(record.text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

function messageRole(record: Record<string, unknown>): 'user' | 'assistant' | null {
  if (record.type === 'user' || record.type === 'assistant') {
    return record.type;
  }
  const message = record.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const role = (message as Record<string, unknown>).role;
    if (role === 'user' || role === 'assistant') return role;
  }
  return null;
}

function messageContent(record: Record<string, unknown>): unknown {
  const message = record.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    return (message as Record<string, unknown>).content;
  }
  return record.content;
}

function turnIdentity(userUuid: string | null, assistantUuid: string | null, user: string, assistant: string): string {
  if (userUuid && assistantUuid) return `${userUuid}\0${assistantUuid}`;
  return createHash('sha256').update(`${user}\0${assistant}`).digest('hex');
}

/**
 * Read a Claude Code transcript JSONL and return the last genuine user/assistant turn.
 * Skips isMeta, tool-only assistants, malformed lines, and files over the byte bound.
 */
export function readLastExchange(
  transcriptPath: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): TranscriptTurn | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return null;

  let lastUser: { text: string; uuid: string | null } | null = null;
  let lastTurn: TranscriptTurn | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      record = value as Record<string, unknown>;
    } catch {
      continue;
    }

    if (record.isMeta === true) continue;

    const role = messageRole(record);
    if (!role) continue;

    const text = extractText(messageContent(record));
    if (!text) continue;

    const uuid = typeof record.uuid === 'string' ? record.uuid : null;
    if (role === 'user') {
      lastUser = { text, uuid };
      continue;
    }

    if (role === 'assistant' && lastUser) {
      lastTurn = {
        user: lastUser.text,
        assistant: text,
        identity: turnIdentity(lastUser.uuid, uuid, lastUser.text, text),
      };
      lastUser = null;
    }
  }

  return lastTurn;
}

async function ensureSessionForStop(
  store: TimStore,
  sessions: SessionManager,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  const existing = await store.read(sessionId);
  if (existing?.metadata.kind === 'session') return true;

  const marker = findMarker(cwd)?.marker ?? readMarker(cwd);
  if (!marker?.project) return false;

  try {
    await sessions.startProjectSession({
      sessionId,
      projectId: marker.project,
      agentName: 'claude',
      cwd,
      harness: 'claude-code',
    });
    return true;
  } catch {
    return false;
  }
}

export async function runClaudeStop(
  store: TimStore,
  payload: ClaudeStopPayload,
  options: { cwd: string },
): Promise<ClaudeStopResult> {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  const transcriptPath =
    typeof payload.transcript_path === 'string' ? payload.transcript_path.trim() : '';
  if (!sessionId || !transcriptPath) return { logged: false };

  const turn = readLastExchange(transcriptPath, MAX_TRANSCRIPT_BYTES);
  if (!turn) return { logged: false };

  const key = createHash('sha256')
    .update(`${sessionId}\0${turn.identity}`)
    .digest('hex');

  const sessions = new SessionManager(store);
  const ready = await ensureSessionForStop(store, sessions, sessionId, options.cwd);
  if (!ready) return { logged: false };

  let logged: Awaited<ReturnType<SessionManager['logExchangeOnce']>>;
  try {
    logged = await sessions.logExchangeOnce(sessionId, key, [
      { role: 'user', content: bounded(turn.user) },
      { role: 'agent', content: bounded(turn.assistant) },
    ]);
  } catch {
    return { logged: false };
  }

  if (logged.length === 0) return { logged: false, duplicate: true };
  return { logged: true, ...(await afterExchangeLogged(store, sessionId, options.cwd)) };
}

/** Test helper: expose counters after stop logging. */
export async function stopExchangeCount(store: TimStore, sessionId: string): Promise<number> {
  return (await deriveCounters(store, sessionId)).exchangeCount;
}
