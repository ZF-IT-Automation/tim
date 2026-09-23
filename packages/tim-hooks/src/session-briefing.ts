// Assembles the substance carried by a session-start directive. Kept out of
// marker.ts because it needs an open TimStore, and marker.ts is on the fast path
// of every hook — importing this module is a deliberate act, never incidental.
import {
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
  KIND_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_EXCHANGE_BATCH,
  CHARS_PER_TOKEN,
  type TimStore,
} from 'tim-store';
import type { Entry } from 'tim-core';
import type { DirectiveBriefing } from './marker.js';

const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled', 'closed', 'wontfix']);
const MAX_OPEN_WORK_ITEMS = 12;
const NOW_OPEN_WORK_ITEMS = 5;
const OPEN_WORK_ITEM_MAX_CHARS = 160;
const STALE_TASK_DAYS = 14;
const NOW_HANDOFF_MAX_LINES = 3;

// Split of briefing.maxTokens: the previous session is the reason the briefing
// exists, open work is the shorter, denser half.
const PREVIOUS_SESSION_BUDGET_SHARE = 0.7;

// Raw tail of the previous session — the turns no batch summary covers. Its own
// share, not "whatever is left": sharing a budget is what starved the brief's
// Recent Sessions block.
const RECENT_EXCHANGE_BUDGET_SHARE = 0.25;
const MAX_RECENT_EXCHANGES = 6;
const RECENT_EXCHANGE_SIDE_MAX_CHARS = 400;

// Share of the previous-session budget a handoff note may take. Bounded because
// clampSummary keeps the tail: an unbounded note would evict the whole summary.
const HANDOFF_NOTE_BUDGET_SHARE = 0.4;

/** Substantive = enough exchanges or an explicit handoff note (G5). */
export const SUBSTANTIVE_MIN_EXCHANGES = 3;
const HANDOFF_LOOKBACK_MS = 30 * 86400_000;

export function isSubstantiveSession(exchangeCount: number, hasHandoffNote: boolean): boolean {
  return exchangeCount >= SUBSTANTIVE_MIN_EXCHANGES || hasHandoffNote;
}

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

/**
 * Newest handoff note and newest checkpoint text under a session's summary node.
 * Checkpoints carry no `metadata.order`, so getChildren returns them oldest-first —
 * the last match of each wins. The note's predicate is the note itself, not `kind`,
 * so any future writer is picked up; the text's is `kind` because only a checkpoint
 * body is a session summary.
 */
async function latestCheckpoint(
  store: TimStore,
  summaryNode: Entry,
): Promise<{ note: string; text: string }> {
  const rootNote = typeof summaryNode.metadata.handoff_note === 'string'
    ? summaryNode.metadata.handoff_note.trim()
    : '';
  const children = await store.getChildren(summaryNode.id);
  let note = rootNote;
  let text = '';
  for (const child of children) {
    if (!note) {
      const childNote = typeof child.metadata.handoff_note === 'string'
        ? child.metadata.handoff_note.trim()
        : '';
      if (childNote) note = childNote;
    }
    if (child.metadata.kind === 'checkpoint' && child.content.trim()) {
      text = child.content.trim();
    }
  }
  return { note, text };
}

/** Title and body of an exchange node, the way the summarizer reads it. */
function entryText(entry: Entry): string {
  const title = entry.title.trim();
  const body = entry.content.trim();
  return [title, body].filter(Boolean).join('\n');
}

/**
 * The turns no batch summary covers, newest last. Every session has such a tail —
 * a batch is only summarized once it is full — and for the last few turns the raw
 * text beats a summary: it is what happened, not a retelling.
 *
 * Deliberately not `showUnsummarized`: that one returns the *oldest* uncovered
 * batch (correct for the summarizer, which works forward), which here would render
 * the opening of a never-summarized session under a "since the last summary" heading.
 */
export async function recentExchanges(
  store: TimStore,
  sessionId: string,
  maxChars: number,
): Promise<string[]> {
  if (maxChars <= 0) return [];
  const exNode = await findChildByKind(store, sessionId, KIND_EXCHANGES_ROOT);
  if (!exNode) return [];

  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  const summaries = summaryNode
    ? await store.getChildByKind(summaryNode.id, KIND_BATCH)
    : [];
  const seqFloor = summaries.reduce(
    (max, s) => Math.max(max, Number(s.metadata.seq_to) || 0),
    0,
  );

  const batches = await store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH);
  const users: Entry[] = [];
  for (const batch of batches) {
    users.push(
      ...(await store.getChildrenBySeq(batch.id)).filter(u => u.metadata.role === 'user'),
    );
  }
  const tail = users
    .filter(u => Number(u.metadata.seq) > seqFloor)
    .sort((a, b) => Number(a.metadata.seq) - Number(b.metadata.seq))
    .slice(-MAX_RECENT_EXCHANGES);

  // Budgeted newest-first so a tight budget drops the oldest turn, then flipped back
  // into chronological order. oneLine collapses whitespace, which is what keeps a
  // pasted stack trace or code block from eating the whole block.
  const blocks: string[] = [];
  let used = 0;
  for (const user of [...tail].reverse()) {
    const agent = (await store.getChildren(user.id)).find(r => r.metadata.role === 'agent');
    const lines = [`▸ ${oneLine(entryText(user), RECENT_EXCHANGE_SIDE_MAX_CHARS)}`];
    if (agent) lines.push(`  ↳ ${oneLine(entryText(agent), RECENT_EXCHANGE_SIDE_MAX_CHARS)}`);
    const block = lines.join('\n');
    if (used + block.length + 1 > maxChars) break;
    used += block.length + 1;
    blocks.unshift(block);
  }
  return blocks;
}

/** Build condensed summary + raw tail for one session. */
async function sessionBriefingContent(
  store: TimStore,
  sessionId: string,
  maxChars: number,
  rawMaxChars: number,
): Promise<{ summary?: string; recent?: string[] }> {
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  const { note, text } = summaryNode
    ? await latestCheckpoint(store, summaryNode).catch(() => ({ note: '', text: '' }))
    : { note: '', text: '' };

  const stored = typeof summaryNode?.metadata.summary === 'string'
    ? summaryNode.metadata.summary
    : '';
  let body = (stored || text || summaryNode?.content || '').trim();
  if (!body && summaryNode) {
    const batchSummaries = await store.getChildByKind(summaryNode.id, KIND_BATCH).catch(() => []);
    body = batchSummaries
      .slice()
      .sort((a, b) => (Number(a.metadata.batch_index) || 0) - (Number(b.metadata.batch_index) || 0))
      .map(b => (b.content ?? '').trim())
      .filter(Boolean)
      .join('\n\n');
  }

  const clampedNote = note
    ? clampSummary(note, Math.floor(maxChars * HANDOFF_NOTE_BUDGET_SHARE))
    : '';

  const summary = clampSummary(
    [body, clampedNote && `handoff: ${clampedNote}`].filter(Boolean).join('\n'),
    maxChars,
  );
  const recent = await recentExchanges(store, sessionId, rawMaxChars).catch(() => []);
  if (!summary && recent.length === 0) return {};
  return {
    ...(summary ? { summary } : {}),
    ...(recent.length > 0 ? { recent } : {}),
  };
}

async function sessionHandoffNote(store: TimStore, sessionId: string): Promise<string> {
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  if (!summaryNode) return '';
  const { note } = await latestCheckpoint(store, summaryNode).catch(() => ({ note: '' }));
  return note;
}

interface PreviousSessionResult {
  label?: string;
  summary?: string;
  recent?: string[];
  sessionId?: string;
  trivialSessionNote?: string;
  latestHandoffLabel?: string;
  latestHandoffNote?: string;
}

/** Newest substantive session; trivial newest is noted, not shown as previous work. */
async function previousSession(
  store: TimStore,
  projectLabel: string,
  maxChars: number,
  rawMaxChars: number,
): Promise<PreviousSessionResult> {
  const sessions = new SessionManager(store);
  const listed = await sessions.listResumableSessions(projectLabel, 50);
  if (listed.length === 0) return {};

  const newest = listed[0];
  const cutoff = Date.now() - HANDOFF_LOOKBACK_MS;

  let chosen = newest;
  for (const candidate of listed) {
    const note = await sessionHandoffNote(store, candidate.sessionId);
    if (isSubstantiveSession(candidate.exchangeCount, Boolean(note))) {
      chosen = candidate;
      break;
    }
  }

  const content = await sessionBriefingContent(store, chosen.sessionId, maxChars, rawMaxChars);
  if (!content.summary && !content.recent?.length) return {};

  const date = (chosen.date ?? chosen.lastActivity).slice(0, 10);
  const bits = [date, `${chosen.exchangeCount} exchanges`];
  if (chosen.tool) bits.push(chosen.tool);

  let trivialSessionNote: string | undefined;
  if (newest.sessionId !== chosen.sessionId) {
    const skipDate = (newest.date ?? newest.lastActivity).slice(0, 10);
    trivialSessionNote =
      `Newest session ${skipDate} (${newest.exchangeCount} exchanges) skipped as trivial`;
  }

  let latestHandoffLabel: string | undefined;
  let latestHandoffNote: string | undefined;
  for (const candidate of listed) {
    const activityMs = Date.parse(candidate.lastActivity);
    if (!Number.isFinite(activityMs) || activityMs < cutoff) break;
    const note = await sessionHandoffNote(store, candidate.sessionId);
    if (!note) continue;
    if (candidate.sessionId === chosen.sessionId) break;
    latestHandoffLabel = (candidate.date ?? candidate.lastActivity).slice(0, 10);
    latestHandoffNote = clampSummary(note, Math.floor(maxChars * HANDOFF_NOTE_BUDGET_SHARE));
    break;
  }

  return {
    sessionId: chosen.sessionId,
    label: bits.join(' · '),
    ...content,
    ...(trivialSessionNote ? { trivialSessionNote } : {}),
    ...(latestHandoffLabel && latestHandoffNote
      ? { latestHandoffLabel, latestHandoffNote }
      : {}),
  };
}

function taskStaleSuffix(updatedAt: string): string {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return '';
  const ageDays = (Date.now() - updatedMs) / 86400_000;
  if (ageDays <= STALE_TASK_DAYS) return '';
  return ` · stale since ${updatedAt.slice(0, 10)}`;
}

function isTaskStale(updatedAt: string): boolean {
  return taskStaleSuffix(updatedAt).length > 0;
}

function staleTasksDrillDown(projectLabel: string): string {
  return `tim_show({what:"tasks", root:"${projectLabel}"})`;
}

function formatOpenWorkLine(
  task: { status?: string | null; priority?: string | null; title: string },
  staleSuffix: string,
): string {
  const status = task.status ?? 'todo';
  const priority = task.priority ? `, ${task.priority}` : '';
  return `- [${status}${priority}] ${oneLine(task.title, OPEN_WORK_ITEM_MAX_CHARS)}${staleSuffix}`;
}

interface OpenWorkEntry {
  task: { id: string; status?: string | null; priority?: string | null; title: string };
  updatedAt: string;
  stale: boolean;
}

async function collectOpenWork(
  store: TimStore,
  projectLabel: string,
): Promise<OpenWorkEntry[]> {
  const tasks = await store.getTasks();
  const entries: OpenWorkEntry[] = [];
  for (const task of tasks) {
    if (task.project_label !== projectLabel) continue;
    if (task.status && CLOSED_TASK_STATUSES.has(task.status)) continue;
    const row = await store.read(task.id, { includeChildren: false });
    const updatedAt = row?.updatedAt ?? '';
    entries.push({
      task,
      updatedAt,
      stale: updatedAt ? isTaskStale(updatedAt) : false,
    });
  }
  return entries;
}

function staleCollapseLine(count: number, oldestDate: string, projectLabel: string): string {
  return `+ ${count} stale open task${count === 1 ? '' : 's'} (untouched since ${oldestDate}) — ${staleTasksDrillDown(projectLabel)}`;
}

function oldestStaleDate(entries: OpenWorkEntry[]): string {
  const dates = entries
    .map(e => e.updatedAt.slice(0, 10))
    .filter(d => d.length > 0)
    .sort();
  return dates[0] ?? 'unknown';
}

/** Open-task lines for briefings; same ordering as the directive's open work. */
export async function formatOpenWorkLines(
  store: TimStore,
  projectLabel: string,
  maxItems: number,
  maxChars: number,
): Promise<string[]> {
  const all = await collectOpenWork(store, projectLabel);
  const fresh = all.filter(e => !e.stale);
  const stale = all.filter(e => e.stale);
  const lines: string[] = [];
  let used = 0;

  const tryPush = (line: string): boolean => {
    if (used + line.length + 1 > maxChars) return false;
    used += line.length + 1;
    lines.push(line);
    return true;
  };

  if (fresh.length > 0) {
    for (const entry of fresh) {
      if (lines.length >= maxItems) break;
      const line = formatOpenWorkLine(entry.task, '');
      if (!tryPush(line)) break;
    }
    if (stale.length > 0) {
      tryPush(staleCollapseLine(stale.length, oldestStaleDate(stale), projectLabel));
    }
    return lines;
  }

  if (stale.length === 0) return lines;

  const previewCount = Math.min(3, stale.length);
  for (const entry of stale.slice(0, previewCount)) {
    const suffix = entry.updatedAt ? taskStaleSuffix(entry.updatedAt) : '';
    tryPush(formatOpenWorkLine(entry.task, suffix));
  }
  const hidden = stale.length - previewCount;
  if (hidden > 0) {
    tryPush(staleCollapseLine(hidden, oldestStaleDate(stale), projectLabel));
  }
  return lines;
}

/** Compact first-screen block: recent handoff + top open tasks (G1, G8). */
export async function buildNowBlock(
  store: TimStore,
  projectLabel: string,
): Promise<string[]> {
  const lines: string[] = ['', '── Now ──', ''];
  const cutoff = Date.now() - HANDOFF_LOOKBACK_MS;
  const sessions = new SessionManager(store);
  const listed = await sessions.listResumableSessions(projectLabel, 50);

  for (const session of listed) {
    const activityMs = Date.parse(session.lastActivity);
    if (!Number.isFinite(activityMs) || activityMs < cutoff) break;
    const note = await sessionHandoffNote(store, session.sessionId);
    if (!note) continue;
    const date = (session.date ?? session.lastActivity).slice(0, 10);
    const clipped = note
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, NOW_HANDOFF_MAX_LINES)
      .join(' ');
    lines.push(`Handoff (${date}): ${oneLine(clipped, 240)}`);
    break;
  }

  const tasks = await formatOpenWorkLines(store, projectLabel, NOW_OPEN_WORK_ITEMS, 4000);
  if (tasks.length > 0) {
    if (lines.length > 3) lines.push('');
    lines.push(...tasks);
  }

  return lines.length > 3 ? lines : [];
}

/** Open tasks of the project, highest-priority first (store already orders them). */
async function openWork(
  store: TimStore,
  projectLabel: string,
  maxChars: number,
): Promise<string[]> {
  return formatOpenWorkLines(store, projectLabel, MAX_OPEN_WORK_ITEMS, maxChars);
}

/**
 * Build the directive briefing for a project. Returns undefined when there is
 * nothing to inject, so the directive falls back to its instruction-only form.
 *
 * `includePastWork` decides whether the previous session comes along. It is a
 * call parameter with one hard-coded value per caller, not a setting: the two
 * automatic callers in tim-cli pass `false`, so a fresh session starts with
 * structure and open work only, and `previewSessionStart` passes `true`, which
 * is what `/tim-continue` renders on demand. Past work is retrieved by topic
 * now (`tim_resume_topic`), not injected by recency into every session that
 * happens to start in this directory.
 */
export async function collectDirectiveBriefing(
  store: TimStore,
  projectLabel: string,
  maxTokens: number,
  includePastWork: boolean,
): Promise<DirectiveBriefing | undefined> {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (maxChars === 0) return undefined;

  const summaryBudget = Math.floor(maxChars * PREVIOUS_SESSION_BUDGET_SHARE);
  const rawBudget = Math.floor(maxChars * RECENT_EXCHANGE_BUDGET_SHARE);

  const previous: PreviousSessionResult = includePastWork
    ? await previousSession(store, projectLabel, summaryBudget, rawBudget).catch(() => ({}))
    : {};
  const recent = previous.recent ?? [];
  const spent = (previous.summary?.length ?? 0)
    + (previous.latestHandoffNote?.length ?? 0)
    + (previous.trivialSessionNote?.length ?? 0)
    + recent.reduce((n, block) => n + block.length + 1, 0);
  const work = await openWork(store, projectLabel, Math.max(0, maxChars - spent)).catch(() => []);

  if (!previous.summary && recent.length === 0 && work.length === 0
    && !previous.trivialSessionNote && !previous.latestHandoffNote) {
    return undefined;
  }
  return {
    ...(previous.label ? { previousSessionLabel: previous.label } : {}),
    ...(previous.summary ? { previousSessionSummary: previous.summary } : {}),
    ...(recent.length > 0 ? { recentExchanges: recent } : {}),
    ...(previous.trivialSessionNote ? { trivialSessionNote: previous.trivialSessionNote } : {}),
    ...(previous.latestHandoffLabel && previous.latestHandoffNote
      ? { latestHandoffLabel: previous.latestHandoffLabel, latestHandoffNote: previous.latestHandoffNote }
      : {}),
    ...(work.length > 0 ? { openWork: work } : {}),
  };
}
