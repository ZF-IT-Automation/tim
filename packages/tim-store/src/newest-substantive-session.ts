import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { findChildByKind, KIND_BATCH, KIND_SUMMARY_ROOT } from './session-tree.js';
import { SessionManager } from './session.js';
import {
  isSubstantiveSession,
  parseSessionSubstance,
} from './substantive-session.js';

/**
 * Handoff note and checkpoint body from a summary root. Child notes use the
 * newest `updatedAt` when the root carries no note — not the first child.
 */
export async function latestCheckpoint(
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

export interface NewestSubstantiveSession {
  sessionId: string;
  date: string;
  lastActivity: string;
  exchangeCount: number;
  tool?: string;
  handoffNote: string;
}

interface InspectedSession {
  note: string;
  text: string;
  summaryNode: Entry | null;
  substantive: boolean;
}

async function inspectSession(
  store: TimStore,
  sessionId: string,
  exchangeCount: number,
): Promise<InspectedSession> {
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  const cp = summaryNode
    ? await latestCheckpoint(store, summaryNode).catch(() => ({ note: '', text: '' }))
    : { note: '', text: '' };
  const substance = parseSessionSubstance(summaryNode?.metadata.substance);
  return {
    ...cp,
    summaryNode,
    substantive: isSubstantiveSession(exchangeCount, Boolean(cp.note), substance),
  };
}

/** Newest substantive session for a project; worker/automation sessions excluded. */
export async function newestSubstantiveSession(
  store: TimStore,
  projectLabel: string,
): Promise<NewestSubstantiveSession | null> {
  const sessions = new SessionManager(store);
  const listed = await sessions.listResumableSessions(projectLabel, 1000);
  for (const candidate of listed) {
    const { note, substantive } = await inspectSession(store, candidate.sessionId, candidate.exchangeCount);
    if (substantive) {
      const date = typeof candidate.date === 'string'
        ? candidate.date
        : candidate.lastActivity;
      return {
        sessionId: candidate.sessionId,
        date,
        lastActivity: candidate.lastActivity,
        exchangeCount: candidate.exchangeCount,
        ...(candidate.tool ? { tool: candidate.tool } : {}),
        handoffNote: note,
      };
    }
  }
  return null;
}

export interface SubstantiveSessionSummary {
  sessionId: string;
  date: string;
  lastActivity: string;
  /** Empty when the summarizer has not reached the session yet. */
  summary: string;
}

/**
 * Substantive sessions whose last activity is after `since` (all when empty),
 * newest first, with their summary text. Same substance rule as
 * `newestSubstantiveSession`. Handoff notes are deliberately not returned.
 */
export async function substantiveSessionsSince(
  store: TimStore,
  projectLabel: string,
  since: string,
): Promise<SubstantiveSessionSummary[]> {
  const sessions = new SessionManager(store);
  const listed = await sessions.listResumableSessions(projectLabel, 1000);
  const out: SubstantiveSessionSummary[] = [];
  for (const candidate of listed) {
    if (since && candidate.lastActivity <= since) break;
    const { text, summaryNode, substantive } = await inspectSession(
      store, candidate.sessionId, candidate.exchangeCount,
    );
    if (!substantive) continue;
    let summary = typeof summaryNode?.metadata.summary === 'string'
      ? summaryNode.metadata.summary.trim()
      : '';
    if (!summary) summary = text;
    if (!summary && summaryNode) {
      const batches = await store.getChildByKind(summaryNode.id, KIND_BATCH).catch(() => []);
      summary = batches
        .slice()
        .sort((a, b) => (Number(a.metadata.batch_index) || 0) - (Number(b.metadata.batch_index) || 0))
        .map(b => (b.content ?? '').trim())
        .filter(Boolean)
        .join(' ');
    }
    out.push({
      sessionId: candidate.sessionId,
      date: typeof candidate.date === 'string' ? candidate.date : candidate.lastActivity,
      lastActivity: candidate.lastActivity,
      summary,
    });
  }
  return out;
}
