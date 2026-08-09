import { createHash } from 'node:crypto';
import type { TimStore } from 'tim-store';
import { SessionManager } from 'tim-store';
import { afterExchangeLogged, type CadenceResult } from './cadence-runner.js';
import { MAX_EXCHANGE_CHARS } from './claude-stop.js';
import { ensureHookSession } from './hook-session.js';

/**
 * Codex 0.147 has no turn-end hook event — its hook surface stops at
 * SessionStart/UserPromptSubmit/SessionEnd, and hooks are skipped entirely
 * until the user grants them persisted trust. The `notify` program in
 * config.toml is the only turn-end callback, it needs no trust, and it already
 * carries the whole exchange, so there is no transcript to parse.
 */
export interface CodexNotifyPayload {
  type?: string;
  'thread-id'?: string;
  'turn-id'?: string;
  cwd?: string;
  'input-messages'?: string[];
  'last-assistant-message'?: string;
  [key: string]: unknown;
}

export interface CodexNotifyResult extends Partial<CadenceResult> {
  logged: boolean;
  duplicate?: boolean;
}

function bounded(text: string, max = MAX_EXCHANGE_CHARS): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('');
}

/**
 * Parse the notify payload out of the argv Codex spawns the program with: it
 * appends the JSON as the final argument, so the command array itself may be
 * spelled any way the installer likes.
 */
export function parseCodexNotifyArgs(args: string[]): CodexNotifyPayload | null {
  const last = args[args.length - 1];
  if (typeof last !== 'string' || !last.trim()) return null;
  try {
    const value = JSON.parse(last) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as CodexNotifyPayload;
  } catch {
    return null;
  }
}

/**
 * `input-messages` holds only what the human sent: Codex injects
 * `<recommended_plugins>` and friends as separate transcript items that never
 * reach this field, so joining every element is safe.
 */
function userText(payload: CodexNotifyPayload): string {
  const messages = payload['input-messages'];
  if (!Array.isArray(messages)) return '';
  return messages.filter((m): m is string => typeof m === 'string').join('\n').trim();
}

export async function runCodexNotify(
  store: TimStore,
  payload: CodexNotifyPayload,
  options: { cwd: string },
): Promise<CodexNotifyResult> {
  // Anything but a completed turn is not an exchange, including a payload that
  // names no type at all — notify carries other event types.
  if (payload.type !== 'agent-turn-complete') return { logged: false };

  const sessionId = typeof payload['thread-id'] === 'string' ? payload['thread-id'].trim() : '';
  const turnId = typeof payload['turn-id'] === 'string' ? payload['turn-id'].trim() : '';
  const user = userText(payload);
  const assistantRaw = payload['last-assistant-message'];
  const assistant = typeof assistantRaw === 'string' ? assistantRaw.trim() : '';
  if (!sessionId || !turnId || !user || !assistant) return { logged: false };

  // turn-id is stable per turn, so a re-fired notify derives the same key.
  const key = createHash('sha256').update(`${sessionId}\0${turnId}`).digest('hex');

  const sessions = new SessionManager(store);
  const ready = await ensureHookSession(store, sessions, sessionId, options.cwd, {
    agentName: 'codex',
    harness: 'codex',
  });
  if (!ready) return { logged: false };

  let logged: Awaited<ReturnType<SessionManager['logExchangeOnce']>>;
  try {
    logged = await sessions.logExchangeOnce(sessionId, key, [
      { role: 'user', content: bounded(user) },
      { role: 'agent', content: bounded(assistant) },
    ]);
  } catch {
    return { logged: false };
  }

  if (logged.length === 0) return { logged: false, duplicate: true };
  return { logged: true, ...(await afterExchangeLogged(store, sessionId, options.cwd)) };
}
