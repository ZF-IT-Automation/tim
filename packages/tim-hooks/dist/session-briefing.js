"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clampSummary = clampSummary;
exports.collectDirectiveBriefing = collectDirectiveBriefing;
// Assembles the substance carried by a session-start directive. Kept out of
// marker.ts because it needs an open TimStore, and marker.ts is on the fast path
// of every hook — importing this module is a deliberate act, never incidental.
const tim_store_1 = require("tim-store");
const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled', 'closed', 'wontfix']);
const MAX_OPEN_WORK_ITEMS = 12;
const OPEN_WORK_ITEM_MAX_CHARS = 160;
// Split of briefing.maxTokens: the previous session is the reason the briefing
// exists, open work is the shorter, denser half.
const PREVIOUS_SESSION_BUDGET_SHARE = 0.7;
// Share of the previous-session budget a handoff note may take. Bounded because
// clampSummary keeps the tail: an unbounded note would evict the whole summary.
const HANDOFF_NOTE_BUDGET_SHARE = 0.4;
/**
 * Clamp a summary to a char budget without losing its end. The last lines of a
 * condensed rollup are the handoff ("next: …") — cutting from the front would drop
 * exactly what the new session needs.
 */
function clampSummary(text, maxChars) {
    const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
    if (lines.length === 0)
        return '';
    const cost = (ls) => ls.reduce((n, l) => n + l.length + 1, -1);
    if (cost(lines) <= maxChars)
        return lines.join('\n');
    if (lines.length === 1) {
        return `…${lines[0].slice(Math.max(0, lines[0].length - maxChars + 1))}`;
    }
    const kept = [];
    let used = 2; // the "…" elision line
    for (let i = lines.length - 1; i >= 0; i--) {
        const next = lines[i].length + 1;
        if (used + next > maxChars)
            break;
        used += next;
        kept.unshift(lines[i]);
    }
    return kept.length > 0 ? ['…', ...kept].join('\n') : '…';
}
function oneLine(text, maxChars) {
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
async function latestCheckpoint(store, summaryNodeId) {
    const children = await store.getChildren(summaryNodeId);
    let note = '';
    let text = '';
    for (const child of children) {
        const childNote = typeof child.metadata.handoff_note === 'string'
            ? child.metadata.handoff_note.trim()
            : '';
        if (childNote)
            note = childNote;
        if (child.metadata.kind === 'checkpoint' && child.content.trim()) {
            text = child.content.trim();
        }
    }
    return { note, text };
}
/** Most recent session of the project, with its condensed rollup summary. */
async function previousSession(store, projectLabel, maxChars) {
    const sessions = new tim_store_1.SessionManager(store);
    const [latest] = await sessions.listResumableSessions(projectLabel, 1);
    if (!latest)
        return {};
    const summaryNode = await (0, tim_store_1.findChildByKind)(store, latest.sessionId, tim_store_1.KIND_SUMMARY_ROOT);
    const { note, text } = summaryNode
        ? await latestCheckpoint(store, summaryNode.id).catch(() => ({ note: '', text: '' }))
        : { note: '', text: '' };
    // Three sources, best first: the summarizer's rollup on the root, then the newest
    // checkpoint's own text — a checkpoint never writes the root, so a session that only
    // ever hit the session-end hook has nothing there — then the root's body.
    const stored = typeof summaryNode?.metadata.summary === 'string'
        ? summaryNode.metadata.summary
        : '';
    const body = (stored || text || summaryNode?.content || '').trim();
    // The handoff note is what the previous session wrote *for this one*, so it goes
    // last: clampSummary drops from the front, which makes the tail the safe slot.
    const clampedNote = note
        ? clampSummary(note, Math.floor(maxChars * HANDOFF_NOTE_BUDGET_SHARE))
        : '';
    const summary = clampSummary([body, clampedNote && `handoff: ${clampedNote}`].filter(Boolean).join('\n'), maxChars);
    if (!summary)
        return {};
    const date = (latest.date ?? latest.lastActivity).slice(0, 10);
    const bits = [date, `${latest.exchangeCount} exchanges`];
    if (latest.tool)
        bits.push(latest.tool);
    return { label: bits.join(' · '), summary };
}
/** Open tasks of the project, highest-priority first (store already orders them). */
async function openWork(store, projectLabel, maxChars) {
    const tasks = await store.getTasks();
    const lines = [];
    let used = 0;
    for (const task of tasks) {
        if (task.project_label !== projectLabel)
            continue;
        if (task.status && CLOSED_TASK_STATUSES.has(task.status))
            continue;
        const status = task.status ?? 'todo';
        const priority = task.priority ? `, ${task.priority}` : '';
        const line = `- [${status}${priority}] ${oneLine(task.title, OPEN_WORK_ITEM_MAX_CHARS)}`;
        if (used + line.length + 1 > maxChars)
            break;
        used += line.length + 1;
        lines.push(line);
        if (lines.length >= MAX_OPEN_WORK_ITEMS)
            break;
    }
    return lines;
}
/**
 * Build the directive briefing for a project. Returns undefined when there is
 * nothing to inject, so the directive falls back to its instruction-only form.
 */
async function collectDirectiveBriefing(store, projectLabel, maxTokens) {
    const maxChars = Math.max(0, Math.floor(maxTokens * tim_store_1.CHARS_PER_TOKEN));
    if (maxChars === 0)
        return undefined;
    const summaryBudget = Math.floor(maxChars * PREVIOUS_SESSION_BUDGET_SHARE);
    const previous = await previousSession(store, projectLabel, summaryBudget).catch(() => ({}));
    const remaining = maxChars - (previous.summary?.length ?? 0);
    const work = await openWork(store, projectLabel, Math.max(0, remaining)).catch(() => []);
    if (!previous.summary && work.length === 0)
        return undefined;
    return {
        ...(previous.label ? { previousSessionLabel: previous.label } : {}),
        ...(previous.summary ? { previousSessionSummary: previous.summary } : {}),
        ...(work.length > 0 ? { openWork: work } : {}),
    };
}
//# sourceMappingURL=session-briefing.js.map