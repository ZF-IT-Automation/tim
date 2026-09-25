// Client for Jev (TypeSafe's decision model, reached through OpenRouter).
//
// Jev never writes text: it takes a `state` and named questions and returns one
// typed answer per question in roughly 400 ms. TIM uses it only as a filter in
// front of behaviour that already works without it, so every failure — no key,
// timeout, 429, a changed endpoint — returns null and the caller keeps today's
// path. Measured shapes and thresholds: P0063 idea "Jev … evaluated for six TIM uses".
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getTimDir } from './config.js';

// The decisions endpoint is young on OpenRouter; keep the URL in one place.
export const JEV_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
export const JEV_MODEL = 'typesafe/jev-1.13';
const DEFAULT_TIMEOUT_MS = 5_000;

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

/**
 * Jev's own key, never OPENROUTER_API_KEY from the environment or ~/.hermes/.env:
 * that one belongs to the summarizer's account, and borrowing it would bill Jev
 * calls somewhere nobody looks.
 */
export function resolveJevApiKey(): string | undefined {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  try {
    const file = path.join(os.homedir(), '.config', 'jev', 'env');
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^\s*(?:JEV_API_KEY|OPENROUTER_API_KEY)=(.+?)\s*$/);
      if (m) return m[1];
    }
  } catch {
    // no file → no Jev
  }
  return undefined;
}

// A silent fallback would let the gain vanish unnoticed when the key expires,
// so every fail-open leaves one line behind. Missing key is not logged: that is
// the configured "off" state, not a failure.
function logJevFailure(caller: string, reason: string): void {
  try {
    const dir = path.join(getTimDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'jev.log'), `${new Date().toISOString()} ${caller} ${reason}\n`);
  } catch {
    // logging must never break the caller
  }
}

/**
 * Ask Jev. Returns the answers keyed like `questions`, or null on any failure
 * (no key, non-200, timeout, malformed body, a question missing from the reply).
 * Callers must treat null as "behave as without Jev".
 */
export async function askJev(
  caller: string,
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, JevAnswer> | null> {
  const key = resolveJevApiKey();
  if (!key) return null;
  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      logJevFailure(caller, `http ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { answers?: Record<string, JevAnswer> };
    const answers = body.answers;
    if (!answers || Object.keys(questions).some(k => !answers[k])) {
      logJevFailure(caller, 'malformed reply');
      return null;
    }
    return answers;
  } catch (err) {
    logJevFailure(caller, (err as Error).name === 'TimeoutError' ? 'timeout' : String(err));
    return null;
  }
}

/** noul probability of one answer, or undefined when the answer is not a noul. */
export function jevNoul(answers: Record<string, JevAnswer>, key: string): number | undefined {
  const a = answers[key];
  return a?.type === 'noul' ? a.noul : undefined;
}
