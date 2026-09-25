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
  isSubstantiveSession,
  parseSessionSubstance,
  isCountableUserExchange,
  taskLastTouch,
  type TimStore,
} from 'tim-store';
import { isClosedBugStatus, taskPriorityRank, type Entry } from 'tim-core';
import { loadBriefStalenessLines } from './brief-staleness.js';
import type { DirectiveBriefing } from './marker.js';

const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled', 'closed', 'wontfix']);
const MAX_OPEN_WORK_ITEMS = 12;
const NOW_OPEN_WORK_ITEMS = 5;
const OPEN_WORK_ITEM_MAX_CHARS = 160;
/** Newer substantive sessions without a handoff after which the last handoff is history. */
const STALE_HANDOFF_SESSIONS = 3;

/** Days of project work (not calendar days) a task may sit untouched before it needs triage. */
const STALE_ACTIVE_DAYS = 7;
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

async function findLatestProjectHandoff(
  store: TimStore,
  projectLabel: string,
): Promise<{ sessionId: string; date: string; note: string; newerSessions: number } | null> {
  const project = await store.requireProject(projectLabel);
  const rows = store.listProjectSessionsByActivity(project.id, 1000, {
    includeZeroExchange: true,
  });
  let newerSessions = 0;
  for (const { id, lastActivity } of rows) {
    const note = await sessionHandoffNote(store, id);
    const session = await store.read(id);
    if (!note) {
      // A newer session with real work but no handoff makes the note's "next" possibly outdated.
      const summaryNode = await findChildByKind(store, id, KIND_SUMMARY_ROOT);
      const exchanges = Number(session?.metadata.exchange_count) || 0;
      if (isSubstantiveSession(exchanges, false, parseSessionSubstance(summaryNode?.metadata.substance))) {
        newerSessions += 1;
      }
      continue;
    }
    // Date the note by when it was written (its checkpoint), not by when a long session began.
    const summaryNode = await findChildByKind(store, id, KIND_SUMMARY_ROOT);
    const checkpoints = summaryNode
      ? (await store.getChildren(summaryNode.id)).filter(c => c.metadata.kind === 'checkpoint')
      : [];
    // Legacy notes have no flagged checkpoint; a note is written at the end of the work, so the
    // session's last activity (exchanges and handoffs) is the closest date.
    const written = checkpoints.filter(c => c.metadata.handoff === true).map(c => c.createdAt).sort().pop();
    const date = (written ?? lastActivity ?? session?.createdAt ?? '').slice(0, 10);
    return { sessionId: id, date, note, newerSessions };
  }
  return null;
}

function handoffLabel(handoff: { date: string; newerSessions: number }): string {
  const newer = handoff.newerSessions > 0
    ? ` · ${handoff.newerSessions} newer session${handoff.newerSessions === 1 ? '' : 's'} without handoff — its next step may be outdated`
    : '';
  return `${handoffAgeLabel(handoff.date)}${newer}`;
}

/** Open-task counts from store.getTasks — shared by load header and Now block. */
export async function countProjectOpenTasks(
  store: TimStore,
  projectLabel: string,
): Promise<{ open: number; stale: number }> {
  const all = await collectOpenWork(store, projectLabel);
  return {
    open: all.length,
    stale: all.filter(entry => entry.stale).length,
  };
}

/** Open-bug count from store.getBugs — same status resolution as the Bugs renderer. */
export async function countProjectOpenBugs(
  store: TimStore,
  projectLabel: string,
): Promise<number> {
  const bugs = await store.getBugs();
  return bugs.filter(
    bug => bug.project_label === projectLabel
      && !isClosedBugStatus(bug.status ?? 'open'),
  ).length;
}

function handoffAgeLabel(isoDate: string): string {
  const ms = Date.parse(isoDate);
  if (!Number.isFinite(ms)) return isoDate.slice(0, 10);
  const days = Math.floor((Date.now() - ms) / 86400_000);
  if (days <= 0) return `${isoDate.slice(0, 10)} · today`;
  if (days === 1) return `${isoDate.slice(0, 10)} · 1d ago`;
  return `${isoDate.slice(0, 10)} · ${days}d ago`;
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
  let newestChildNoteAt = '';
  for (const child of children) {
    const childNote = typeof child.metadata.handoff_note === 'string'
      ? child.metadata.handoff_note.trim()
      : '';
    if (!rootNote && childNote) {
      const at = child.updatedAt || child.createdAt;
      if (!note || at.localeCompare(newestChildNoteAt) >= 0) {
        note = childNote;
        newestChildNoteAt = at;
      }
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
  const turns: { user: Entry; agentLine: string | null }[] = [];
  let pendingAgent: string | null = null;
  for (const batch of batches) {
    const batchUsers = (await store.getChildrenBySeq(batch.id)).filter(
      u => u.metadata.role === 'user',
    );
    for (const u of batchUsers) {
      const agent = (await store.getChildren(u.id)).find(r => r.metadata.role === 'agent');
      const agentText = agent
        ? oneLine(entryText(agent), RECENT_EXCHANGE_SIDE_MAX_CHARS)
        : null;
      if (!isCountableUserExchange(u)) {
        if (agentText) {
          if (turns.length > 0) {
            const last = turns[turns.length - 1]!;
            last.agentLine = last.agentLine ? `${last.agentLine}\n${agentText}` : agentText;
          } else {
            pendingAgent = pendingAgent ? `${pendingAgent}\n${agentText}` : agentText;
          }
        }
        continue;
      }
      let agentLine = agentText;
      if (pendingAgent) {
        agentLine = agentLine ? `${agentLine}\n${pendingAgent}` : pendingAgent;
        pendingAgent = null;
      }
      turns.push({ user: u, agentLine });
    }
  }
  const tail = turns
    .filter(t => Number(t.user.metadata.seq) > seqFloor)
    .sort((a, b) => Number(a.user.metadata.seq) - Number(b.user.metadata.seq))
    .slice(-MAX_RECENT_EXCHANGES);

  // Budgeted newest-first so a tight budget drops the oldest turn, then flipped back
  // into chronological order. oneLine collapses whitespace, which is what keeps a
  // pasted stack trace or code block from eating the whole block.
  const blocks: string[] = [];
  let used = 0;
  for (const { user, agentLine } of [...tail].reverse()) {
    const lines = [`▸ ${oneLine(entryText(user), RECENT_EXCHANGE_SIDE_MAX_CHARS)}`];
    if (agentLine) lines.push(`  ↳ ${agentLine}`);
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
  latestHandoffLabel?: string;
  latestHandoffNote?: string;
}

/** Newest substantive session; non-substantive sessions are not candidates. */
async function previousSession(
  store: TimStore,
  projectLabel: string,
  maxChars: number,
  rawMaxChars: number,
): Promise<PreviousSessionResult> {
  const sessions = new SessionManager(store);
  // Scan past bursts of short automation sessions: a fixed window of 50 was filled
  // entirely by summarizer/automation sessions on a live DB and hid everything.
  const listed = await sessions.listResumableSessions(projectLabel, 1000);
  const projectHandoff = await findLatestProjectHandoff(store, projectLabel);
  const handoffOnly = (excludeSessionId?: string): PreviousSessionResult =>
    projectHandoff && projectHandoff.sessionId !== excludeSessionId
      ? {
          latestHandoffLabel: handoffLabel(projectHandoff),
          latestHandoffNote: clampSummary(
            projectHandoff.note,
            Math.floor(maxChars * HANDOFF_NOTE_BUDGET_SHARE),
          ),
        }
      : {};
  if (listed.length === 0) return handoffOnly();

  let chosen: (typeof listed)[number] | undefined;
  for (const candidate of listed) {
    const summaryNode = await findChildByKind(store, candidate.sessionId, KIND_SUMMARY_ROOT);
    const note = await sessionHandoffNote(store, candidate.sessionId);
    const substance = parseSessionSubstance(summaryNode?.metadata.substance);
    if (isSubstantiveSession(candidate.exchangeCount, Boolean(note), substance)) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) return handoffOnly();

  const content = await sessionBriefingContent(store, chosen.sessionId, maxChars, rawMaxChars);
  if (!content.summary && !content.recent?.length) return handoffOnly();

  const date = (chosen.date ?? chosen.lastActivity).slice(0, 10);
  const bits = [date, `${chosen.exchangeCount} exchanges`];
  if (chosen.tool) bits.push(chosen.tool);

  return {
    sessionId: chosen.sessionId,
    label: bits.join(' · '),
    ...content,
    ...handoffOnly(chosen.sessionId),
  };
}

/** Project work days after the last touch. A paused project stops the clock. */
function activeDaysSince(updatedAt: string, activeDays: string[]): number {
  const day = updatedAt.slice(0, 10);
  return activeDays.filter(d => d > day).length;
}

/** FNV-1a of the task id: a stable ring position that does not depend on age or backlog size. */
function rotationKey(id: string): number {
  let h = 0x811c9dc5;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** Marks a stale line; the id follows on every line (formatOpenWorkLine). */
function taskStaleSuffix(entry: OpenWorkEntry): string {
  return entry.stale ? ` · stale since ${entry.updatedAt.slice(0, 10)}` : '';
}

function staleTasksDrillDown(projectLabel: string): string {
  return `tim_show({what:"tasks", root:"${projectLabel}"})`;
}

/** Every line ends with the id, so acting on it needs no second lookup. */
function formatOpenWorkLine(
  task: { id: string; status?: string | null; priority?: string | null; title: string },
  staleSuffix: string,
): string {
  const status = task.status ?? 'todo';
  // One scale on screen: high/medium/… and P0–P3 are the same ranks (taskPriorityRank).
  const rank = taskPriorityRank(task.priority);
  const priority = rank < 4 ? `, P${rank}` : task.priority ? `, ${task.priority}` : '';
  // Titles copied from markdown bodies start with "# " / "## TASK:" — noise in a list line.
  const title = task.title.replace(/^\s*#+\s*/, '');
  return `- [${status}${priority}] ${oneLine(title, OPEN_WORK_ITEM_MAX_CHARS)}${staleSuffix} · ${task.id}`;
}

interface OpenWorkEntry {
  task: { id: string; status?: string | null; priority?: string | null; title: string };
  updatedAt: string;
  stale: boolean;
}

async function collectOpenWork(
  store: TimStore,
  projectLabel: string,
): Promise<OpenWorkEntry[] & { activeDayCount?: number }> {
  const tasks = await store.getTasks();
  const project = await store.requireProject(projectLabel);
  const activeDays = store.getProjectActiveDays(project.id);
  const open = tasks.filter(task =>
    task.project_label === projectLabel && !(task.status && CLOSED_TASK_STATUSES.has(task.status)));
  // Work logged under a task or pointing at it keeps the task fresh, like editing it would.
  const workLogged = store.getTaskWorkLoggedAt(open.map(t => t.id));
  const entries: OpenWorkEntry[] = [];
  const series = new Map<string, Array<{ id: string; createdAt: string; keep: number }>>();
  for (const task of open) {
    const row = await store.read(task.id, { includeChildren: false });
    // Retention "latest-wins": entries sharing metadata.series show only the newest
    // metadata.series_keep (default 1) in briefings. Nothing is closed or deleted.
    const key = typeof row?.metadata.series === 'string' ? row.metadata.series.trim() : '';
    if (row && key) {
      const keep = Number(row.metadata.series_keep);
      const members = series.get(key) ?? [];
      members.push({ id: task.id, createdAt: row.createdAt, keep: keep >= 1 ? Math.floor(keep) : 1 });
      series.set(key, members);
    }
    const touched = row ? taskLastTouch(row) : '';
    const logged = workLogged.get(task.id) ?? '';
    // A future creation time (skewed peer) is not work done; see taskLastTouch.
    const loggedAt = logged <= new Date().toISOString() ? logged : '';
    const updatedAt = loggedAt > touched ? loggedAt : touched;
    entries.push({
      task,
      updatedAt,
      stale: updatedAt ? activeDaysSince(updatedAt, activeDays) >= STALE_ACTIVE_DAYS : false,
    });
  }
  const superseded = new Set<string>();
  for (const members of series.values()) {
    members.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    for (const m of members.slice(members[0]!.keep)) superseded.add(m.id);
  }
  const kept = entries.filter(e => !superseded.has(e.task.id));
  return Object.assign(kept, { activeDayCount: activeDays.length });
}

/** Staleness cannot be resolved automatically — only the agent can tell done from obsolete. */
const STALE_TRIAGE_LINE =
  `Stale = untouched over ${STALE_ACTIVE_DAYS}+ days of project work. Check before relying on it:`
  + ' done → tim_update metadata.task.status "done"; still valid → tim_verify(id);'
  + ' obsolete (code or log shows it) → tim_update irrelevant:true. Unsure → leave it and ask the user.';

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

  // Stable ring order (hash of the id), window start = floor(frac(day × golden ratio) × n).
  // The golden-ratio sequence spreads evenly whatever n is, so the window never freezes while
  // the backlog grows (an index offset d % n did). Steady backlog: every stale task shows within
  // n work days (simulated worst 0.95·n with a window of 2). A backlog that grows by about the
  // window size per day has no bound; its tasks stay in the collapse count meanwhile.
  const previewCount = Math.min(fresh.length > 0 ? 2 : 3, stale.length);
  const ring = [...stale].sort((a, b) => rotationKey(a.task.id) - rotationKey(b.task.id));
  const start = Math.floor((((all.activeDayCount ?? 0) * 0.6180339887498949) % 1) * ring.length);
  const rotated = [...ring.slice(start), ...ring.slice(0, start)];
  const staleLines: string[] = [];
  if (rotated.length > 0) {
    staleLines.push(STALE_TRIAGE_LINE);
    for (const entry of rotated.slice(0, previewCount)) {
      staleLines.push(formatOpenWorkLine(entry.task, taskStaleSuffix(entry)));
    }
    const hidden = rotated.slice(previewCount);
    if (hidden.length > 0) {
      staleLines.push(staleCollapseLine(hidden.length, oldestStaleDate(hidden), projectLabel));
    }
  }

  // Reserve room for the stale block (or, if it can never fit, its one-line count) and the
  // overflow count before fresh lines fill the budget: nothing disappears without a trace.
  const overflowReserve = 80;
  const fullStale = staleLines.reduce((n, l) => n + l.length + 1, 0);
  const collapseAll = rotated.length > 0
    ? staleCollapseLine(rotated.length, oldestStaleDate(rotated), projectLabel) : '';
  const staleFits = fullStale + overflowReserve <= maxChars;
  const staleReserve = staleFits ? fullStale : collapseAll.length + (collapseAll ? 1 : 0);
  const freshBudget = maxChars - staleReserve - overflowReserve;
  let shownFresh = 0;
  for (const entry of fresh) {
    const line = formatOpenWorkLine(entry.task, '');
    if (shownFresh >= maxItems || used + line.length + 1 > freshBudget) break;
    tryPush(line);
    shownFresh += 1;
  }
  if (shownFresh < fresh.length) {
    tryPush(`+ ${fresh.length - shownFresh} more open task${fresh.length - shownFresh === 1 ? '' : 's'} — ${staleTasksDrillDown(projectLabel)}`);
  }
  if (rotated.length === 0) return lines;
  if (staleFits && used + fullStale <= maxChars) {
    for (const line of staleLines) tryPush(line);
  } else {
    tryPush(collapseAll);
  }
  return lines;
}

/** Compact first-screen block: recent handoff + top open tasks (G1, G8). */
export async function buildNowBlock(
  store: TimStore,
  projectLabel: string,
): Promise<string[]> {
  const lines: string[] = ['', '── Now ──', ''];
  const handoff = await findLatestProjectHandoff(store, projectLabel);
  if (handoff && handoff.newerSessions >= STALE_HANDOFF_SESSIONS) {
    // Several sessions of work since: the note is history, not the current next step.
    lines.push(`Last handoff is ${handoff.newerSessions} sessions old (${handoff.date}) — not shown; tim_resume_list({projectId:"${projectLabel}"})`);
  } else if (handoff) {
    const clipped = handoff.note
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, NOW_HANDOFF_MAX_LINES)
      .join(' ');
    lines.push(`Handoff (${handoffLabel(handoff)}): ${oneLine(clipped, 240)}`);
  }

  const tasks = await formatOpenWorkLines(store, projectLabel, NOW_OPEN_WORK_ITEMS, 4000);
  if (tasks.length > 0) {
    if (lines.length > 3) lines.push('');
    lines.push(...tasks);
  }

  // An empty project still gets the block: "nothing open" is an answer, silence is not.
  if (lines.length === 3) {
    lines.push(`No open work or handoff recorded — add tasks with tim_write where:"${projectLabel}/Tasks".`);
  }
  return lines;
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

  // Outside the token split. A quiet project still needs the warning, and
  // the lines must not shrink the previous-session or open-work budgets.
  const staleBrief = await loadBriefStalenessLines(store, projectLabel);

  const summaryBudget = Math.floor(maxChars * PREVIOUS_SESSION_BUDGET_SHARE);
  const rawBudget = Math.floor(maxChars * RECENT_EXCHANGE_BUDGET_SHARE);

  const previous: PreviousSessionResult = includePastWork
    ? await previousSession(store, projectLabel, summaryBudget, rawBudget).catch(() => ({}))
    : {};
  const recent = previous.recent ?? [];
  const spent = (previous.summary?.length ?? 0)
    + (previous.latestHandoffNote?.length ?? 0)
    + recent.reduce((n, block) => n + block.length + 1, 0);
  const work = await openWork(store, projectLabel, Math.max(0, maxChars - spent)).catch(() => []);

  if (!previous.summary && recent.length === 0 && work.length === 0
    && !previous.latestHandoffNote && staleBrief.length === 0) {
    return undefined;
  }
  return {
    ...(previous.label ? { previousSessionLabel: previous.label } : {}),
    ...(previous.summary ? { previousSessionSummary: previous.summary } : {}),
    ...(recent.length > 0 ? { recentExchanges: recent } : {}),
    ...(previous.latestHandoffLabel && previous.latestHandoffNote
      ? { latestHandoffLabel: previous.latestHandoffLabel, latestHandoffNote: previous.latestHandoffNote }
      : {}),
    ...(work.length > 0 ? { openWork: work } : {}),
    ...(staleBrief.length > 0 ? { staleBrief } : {}),
  };
}
