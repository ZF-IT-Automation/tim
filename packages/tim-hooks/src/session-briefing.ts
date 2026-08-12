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
const OPEN_WORK_ITEM_MAX_CHARS = 160;

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
  summaryNodeId: string,
): Promise<{ note: string; text: string }> {
  const children = await store.getChildren(summaryNodeId);
  let note = '';
  let text = '';
  for (const child of children) {
    const childNote = typeof child.metadata.handoff_note === 'string'
      ? child.metadata.handoff_note.trim()
      : '';
    if (childNote) note = childNote;
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

/** Most recent session of the project, with its condensed rollup summary. */
async function previousSession(
  store: TimStore,
  projectLabel: string,
  maxChars: number,
  rawMaxChars: number,
): Promise<{ label?: string; summary?: string; recent?: string[] }> {
  const sessions = new SessionManager(store);
  const [latest] = await sessions.listResumableSessions(projectLabel, 1);
  if (!latest) return {};

  const summaryNode = await findChildByKind(store, latest.sessionId, KIND_SUMMARY_ROOT);
  const { note, text } = summaryNode
    ? await latestCheckpoint(store, summaryNode.id).catch(() => ({ note: '', text: '' }))
    : { note: '', text: '' };

  // Four sources, best first: the summarizer's rollup on the root, then the newest
  // checkpoint's own text — a checkpoint never writes the root, so a session that only
  // ever hit the session-end hook has nothing there — then the root's body, and
  // finally the batch summaries themselves.
  //
  // The last one is not hypothetical. Measured across 336 sessions: 45 have no
  // rollup, 35 of those have no usable checkpoint either, and for 13 of them the
  // raw tail is empty too, because every exchange is covered by a batch summary.
  // Those 13 produced an empty briefing while carrying up to 3010 characters of
  // batch summaries that nothing ever read.
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

  // The handoff note is what the previous session wrote *for this one*, so it goes
  // last: clampSummary drops from the front, which makes the tail the safe slot.
  const clampedNote = note
    ? clampSummary(note, Math.floor(maxChars * HANDOFF_NOTE_BUDGET_SHARE))
    : '';

  const summary = clampSummary(
    [body, clampedNote && `handoff: ${clampedNote}`].filter(Boolean).join('\n'),
    maxChars,
  );
  // Read the raw tail before giving up on the summary: a session the summarizer never
  // reached has no rollup, no checkpoint text and no note — exactly the case the raw
  // turns exist for.
  const recent = await recentExchanges(store, latest.sessionId, rawMaxChars).catch(() => []);
  if (!summary && recent.length === 0) return {};

  const date = (latest.date ?? latest.lastActivity).slice(0, 10);
  const bits = [date, `${latest.exchangeCount} exchanges`];
  if (latest.tool) bits.push(latest.tool);
  return {
    label: bits.join(' · '),
    ...(summary ? { summary } : {}),
    ...(recent.length > 0 ? { recent } : {}),
  };
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

  const previous: { label?: string; summary?: string; recent?: string[] } = includePastWork
    ? await previousSession(store, projectLabel, summaryBudget, rawBudget).catch(() => ({}))
    : {};
  const recent = previous.recent ?? [];
  const spent = (previous.summary?.length ?? 0)
    + recent.reduce((n, block) => n + block.length + 1, 0);
  const work = await openWork(store, projectLabel, Math.max(0, maxChars - spent)).catch(() => []);

  if (!previous.summary && recent.length === 0 && work.length === 0) return undefined;
  return {
    ...(previous.label ? { previousSessionLabel: previous.label } : {}),
    ...(previous.summary ? { previousSessionSummary: previous.summary } : {}),
    ...(recent.length > 0 ? { recentExchanges: recent } : {}),
    ...(work.length > 0 ? { openWork: work } : {}),
  };
}
