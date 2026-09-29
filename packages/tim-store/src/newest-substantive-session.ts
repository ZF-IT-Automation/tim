import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { findChildByKind, KIND_SUMMARY_ROOT } from './session-tree.js';
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

/** Newest substantive session for a project; worker/automation sessions excluded. */
export async function newestSubstantiveSession(
  store: TimStore,
  projectLabel: string,
): Promise<NewestSubstantiveSession | null> {
  const sessions = new SessionManager(store);
  const listed = await sessions.listResumableSessions(projectLabel, 1000);
  for (const candidate of listed) {
    const summaryNode = await findChildByKind(store, candidate.sessionId, KIND_SUMMARY_ROOT);
    let note = '';
    if (summaryNode) {
      const cp = await latestCheckpoint(store, summaryNode).catch(() => ({ note: '', text: '' }));
      note = cp.note;
    }
    const substance = parseSessionSubstance(summaryNode?.metadata.substance);
    if (isSubstantiveSession(candidate.exchangeCount, Boolean(note), substance)) {
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
