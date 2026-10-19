import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TimStore } from 'tim-store';
import { excerpt, jevKeep, JEV_GUARD, JEV_GUARD_KEEP, raceWithTimeout, type PromptSubmitResult } from './prompt-submit.js';
import { scrubCommand } from './risky-command.js';

/** One search plus one parallel Jev round (700 ms deadline each), inside the 3 s hook timeout. */
const TIMEOUT_MS = 1500;
/** Enough for the words that matter; a heredoc body would only add chance keyword matches. */
const SEARCH_CHARS = 500;

export interface ToolGuardParams {
  command: string;
  /** The Bash tool's own one-line description: plain words, good search terms. */
  description?: string;
  projectLabel: string;
  sessionId?: string;
}

// Learnings already shown this session: a second `git push` gets no repeat and costs no Jev call.
function seenFile(sessionId: string): string {
  return path.join(os.tmpdir(), `tim-tool-guard-${sessionId.replace(/[^\w-]/g, '_')}.json`);
}

function readSeen(sessionId?: string): Set<string> {
  if (!sessionId) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(seenFile(sessionId), 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

function writeSeen(sessionId: string | undefined, ids: Set<string>): void {
  if (!sessionId) return;
  try {
    fs.writeFileSync(seenFile(sessionId), JSON.stringify([...ids]));
  } catch {
    // Best effort: without it a learning may show twice.
  }
}

async function computeToolGuard(store: TimStore, params: ToolGuardParams): Promise<PromptSubmitResult | null> {
  // Tokens out before anything is searched or leaves the machine; a path keeps only its last
  // part ("old-clone"), since /home/bbbee/projects/… would match half the database.
  const command = scrubCommand(params.command).replace(/\S*[/\\](?=[^\s/\\])/g, '');
  const description = scrubCommand(params.description?.trim() ?? '');
  const action = [command.slice(0, SEARCH_CHARS), description].filter(Boolean).join('\n');
  const seen = readSeen(params.sessionId);
  const hits = (await store.searchFailures(action, { projectLabel: params.projectLabel, limit: 3 }))
    .filter(hit => !seen.has(hit.id));
  if (hits.length === 0) return null;

  // No Jev answer, no line: this runs before every risky command, unjudged hits would be noise.
  const kept = await jevKeep(`Run in Bash: ${action}`, hits, JEV_GUARD, JEV_GUARD_KEEP);
  if (!kept || kept.length === 0) return null;
  for (const { hit } of kept) seen.add(hit.id);
  writeSeen(params.sessionId, seen);

  const lines = kept.map(({ hit, text }) => {
    const kind = [hit.metadata.kind, hit.metadata.type].find(k => typeof k === 'string') ?? 'warning';
    return `TIM guard (${kind}): ${hit.title} [${hit.id}] — ${excerpt(text)}`;
  });
  return { lines, context: lines.join('\n') };
}

/**
 * PreToolUse guard for a Bash command: learnings and errors from all projects that Jev says
 * apply to running it. Never throws; null when nothing applies, Jev is silent or time runs out.
 */
export async function runToolGuard(store: TimStore, params: ToolGuardParams): Promise<PromptSubmitResult | null> {
  try {
    return await raceWithTimeout(computeToolGuard(store, params), TIMEOUT_MS);
  } catch {
    return null;
  }
}
