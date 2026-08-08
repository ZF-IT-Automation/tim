// Assembles the substance carried by a session-start directive. Kept out of
// marker.ts because it needs an open TimStore, and marker.ts is on the fast path
// of every hook — importing this module is a deliberate act, never incidental.
import {
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
  CHARS_PER_TOKEN,
  type TimStore,
} from 'tim-store';
import type { DirectiveBriefing } from './marker.js';

const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled', 'closed', 'wontfix']);
const MAX_OPEN_WORK_ITEMS = 12;
const OPEN_WORK_ITEM_MAX_CHARS = 160;

// Split of briefing.maxTokens: the previous session is the reason the briefing
// exists, open work is the shorter, denser half.
const PREVIOUS_SESSION_BUDGET_SHARE = 0.7;

/**
 * Clamp a summary to a char budget without losing its end. The last lines of a
 * condensed rollup are the handoff ("next: …") — cutting from the front would drop
 * exactly what the new session needs.
 */
export function clampSummary(text: string, maxChars: number): string {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  if (lines.length === 0) return '';

  const cost = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, -1);
  if (cost(lines) <= maxChars) return lines.join('\n');

  if (lines.length === 1) {
    return `…${lines[0].slice(Math.max(0, lines[0].length - maxChars + 1))}`;
  }

  const kept: string[] = [];
  let used = 2; // the "…" elision line
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = lines[i].length + 1;
    if (used + next > maxChars) break;
    used += next;
    kept.unshift(lines[i]);
  }
  return kept.length > 0 ? ['…', ...kept].join('\n') : '…';
}

function oneLine(text: string, maxChars: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= maxChars ? t : `${t.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Most recent session of the project, with its condensed rollup summary. */
async function previousSession(
  store: TimStore,
  projectLabel: string,
  maxChars: number,
): Promise<{ label?: string; summary?: string }> {
  const sessions = new SessionManager(store);
  const [latest] = await sessions.listResumableSessions(projectLabel, 1);
  if (!latest) return {};

  const summaryNode = await findChildByKind(store, latest.sessionId, KIND_SUMMARY_ROOT);
  const stored = typeof summaryNode?.metadata.summary === 'string'
    ? summaryNode.metadata.summary
    : '';
  const summary = clampSummary((stored || summaryNode?.content || '').trim(), maxChars);
  if (!summary) return {};

  const date = (latest.date ?? latest.lastActivity).slice(0, 10);
  const bits = [date, `${latest.exchangeCount} exchanges`];
  if (latest.tool) bits.push(latest.tool);
  return { label: bits.join(' · '), summary };
}

/** Open tasks of the project, highest-priority first (store already orders them). */
async function openWork(
  store: TimStore,
  projectLabel: string,
  maxChars: number,
): Promise<string[]> {
  const tasks = await store.getTasks();
  const lines: string[] = [];
  let used = 0;

  for (const task of tasks) {
    if (task.project_label !== projectLabel) continue;
    if (task.status && CLOSED_TASK_STATUSES.has(task.status)) continue;

    const status = task.status ?? 'todo';
    const priority = task.priority ? `, ${task.priority}` : '';
    const line = `- [${status}${priority}] ${oneLine(task.title, OPEN_WORK_ITEM_MAX_CHARS)}`;
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    lines.push(line);
    if (lines.length >= MAX_OPEN_WORK_ITEMS) break;
  }
  return lines;
}

/**
 * Build the directive briefing for a project. Returns undefined when there is
 * nothing to inject, so the directive falls back to its instruction-only form.
 */
export async function collectDirectiveBriefing(
  store: TimStore,
  projectLabel: string,
  maxTokens: number,
): Promise<DirectiveBriefing | undefined> {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (maxChars === 0) return undefined;

  const summaryBudget = Math.floor(maxChars * PREVIOUS_SESSION_BUDGET_SHARE);

  const previous: { label?: string; summary?: string } =
    await previousSession(store, projectLabel, summaryBudget).catch(() => ({}));
  const remaining = maxChars - (previous.summary?.length ?? 0);
  const work = await openWork(store, projectLabel, Math.max(0, remaining)).catch(() => []);

  if (!previous.summary && work.length === 0) return undefined;
  return {
    ...(previous.label ? { previousSessionLabel: previous.label } : {}),
    ...(previous.summary ? { previousSessionSummary: previous.summary } : {}),
    ...(work.length > 0 ? { openWork: work } : {}),
  };
}
