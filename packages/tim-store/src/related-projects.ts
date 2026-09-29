import type { Edge, Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { findChildByKind, KIND_SUMMARY_ROOT } from './session-tree.js';
import { SessionManager } from './session.js';
import {
  isSubstantiveSession,
  parseSessionSubstance,
  sessionHasHandoffNote,
} from './substantive-session.js';
import { projectDisplayNameFromEntry } from './project-display.js';

export const RELATED_EDGE_TYPE = 'related' as const;

export interface RelatedProjectInfo {
  label: string;
  displayName: string;
  description?: string;
  lastActivity: string;
  projectId: string;
}

function isArchivedProject(entry: Entry): boolean {
  return entry.metadata.status === 'archived';
}

function projectDescription(entry: Entry): string | undefined {
  const d = entry.metadata.description;
  return typeof d === 'string' && d.trim() ? d.trim() : undefined;
}

function relatedPairEdge(edges: Edge[], aId: string, bId: string): Edge | undefined {
  return edges.find(
    e => e.type === RELATED_EDGE_TYPE
      && ((e.sourceId === aId && e.targetId === bId) || (e.sourceId === bId && e.targetId === aId)),
  );
}

async function neighbourEntryFromEdge(
  store: TimStore,
  rootId: string,
  edge: Edge,
): Promise<Entry | null> {
  const otherId = edge.sourceId === rootId ? edge.targetId : edge.sourceId;
  const entry = await store.read(otherId);
  if (!entry || entry.metadata.kind !== 'project') return null;
  if (isArchivedProject(entry)) return null;
  return entry;
}

export async function listRelatedProjects(
  store: TimStore,
  projectLabel: string,
): Promise<RelatedProjectInfo[]> {
  const root = await store.requireProject(projectLabel);
  const edges = await store.getEdges(root.id, 'both');
  const related = edges.filter(e => e.type === RELATED_EDGE_TYPE);
  const seen = new Set<string>();
  const out: RelatedProjectInfo[] = [];

  for (const edge of related) {
    const entry = await neighbourEntryFromEdge(store, root.id, edge);
    if (!entry) continue;
    const label = String(entry.metadata.label ?? entry.id);
    if (seen.has(label)) continue;
    seen.add(label);
    const stats = store.getProjectEntryStats(entry.id);
    out.push({
      label,
      displayName: projectDisplayNameFromEntry(entry),
      description: projectDescription(entry),
      lastActivity: stats.lastActivity,
      projectId: entry.id,
    });
  }

  out.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.label.localeCompare(b.label));
  return out;
}

export function formatRelatedProjectLine(info: RelatedProjectInfo): string {
  const base = `${info.label} — ${info.displayName}`;
  const desc = info.description?.trim();
  const withDesc = desc ? `${base} · ${desc}` : base;
  return `${withDesc} · tim_load_project({ label: "${info.label}", bind: false })`;
}

export async function relateProjects(
  store: TimStore,
  labelA: string,
  labelB: string,
): Promise<'linked' | 'noop-self' | 'noop-exists'> {
  const a = await store.requireProject(labelA);
  const b = await store.requireProject(labelB);
  if (a.id === b.id) return 'noop-self';

  const edgesA = await store.getEdges(a.id, 'both');
  if (relatedPairEdge(edgesA, a.id, b.id)) return 'noop-exists';

  await store.link(a.id, b.id, RELATED_EDGE_TYPE);
  return 'linked';
}

export async function unrelateProjects(
  store: TimStore,
  labelA: string,
  labelB: string,
): Promise<boolean> {
  const a = await store.requireProject(labelA);
  const b = await store.requireProject(labelB);
  const edgesA = await store.getEdges(a.id, 'both');
  const edge = relatedPairEdge(edgesA, a.id, b.id);
  if (!edge) return false;
  await store.unlink(edge.id);
  return true;
}

export async function setProjectDescription(
  store: TimStore,
  projectLabel: string,
  description: string,
): Promise<void> {
  const project = await store.requireProject(projectLabel);
  const text = description.trim();
  if (!text) throw new Error('description must be non-empty');
  await store.update(project.id, { metadata: { description: text } });
}

export interface SubstantiveSessionHead {
  sessionId: string;
  date: string;
  lastActivity: string;
}

async function sessionHandoffNote(store: TimStore, sessionId: string): Promise<string> {
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  if (!summaryNode) return '';
  if (sessionHasHandoffNote(summaryNode.metadata)) {
    const note = summaryNode.metadata.handoff_note;
    return typeof note === 'string' ? note.trim() : '';
  }
  const children = await store.getChildren(summaryNode.id);
  for (const child of children) {
    if (sessionHasHandoffNote(child.metadata)) {
      const note = child.metadata.handoff_note;
      return typeof note === 'string' ? note.trim() : '';
    }
  }
  return '';
}

/** Newest substantive session for a project; worker/automation sessions excluded. */
export async function findNewestSubstantiveSession(
  store: TimStore,
  projectLabel: string,
): Promise<SubstantiveSessionHead | null> {
  const sessions = new SessionManager(store);
  const listed = await sessions.listResumableSessions(projectLabel, 1000);
  for (const candidate of listed) {
    const summaryNode = await findChildByKind(store, candidate.sessionId, KIND_SUMMARY_ROOT);
    const note = await sessionHandoffNote(store, candidate.sessionId);
    const substance = parseSessionSubstance(summaryNode?.metadata.substance);
    if (isSubstantiveSession(candidate.exchangeCount, Boolean(note), substance)) {
      const date = typeof candidate.date === 'string'
        ? candidate.date
        : candidate.lastActivity;
      return {
        sessionId: candidate.sessionId,
        date,
        lastActivity: candidate.lastActivity,
      };
    }
  }
  return null;
}

export interface NewerNeighbourHandoff {
  label: string;
  displayName: string;
  date: string;
  handoffNote: string;
}

export async function collectNewerNeighbourHandoffs(
  store: TimStore,
  projectLabel: string,
  maxNoteChars: number,
): Promise<NewerNeighbourHandoff[]> {
  const own = await findNewestSubstantiveSession(store, projectLabel);
  const ownActivity = own?.lastActivity ?? '';
  const neighbours = await listRelatedProjects(store, projectLabel);
  const out: NewerNeighbourHandoff[] = [];

  for (const n of neighbours) {
    const theirs = await findNewestSubstantiveSession(store, n.label);
    if (!theirs) continue;
    if (ownActivity && theirs.lastActivity <= ownActivity) continue;

    const note = await sessionHandoffNote(store, theirs.sessionId);
    const clipped = note.length > maxNoteChars
      ? `${note.slice(0, Math.max(0, maxNoteChars - 1)).trimEnd()}…`
      : note;

    out.push({
      label: n.label,
      displayName: n.displayName,
      date: theirs.date.slice(0, 10),
      handoffNote: clipped,
    });
  }

  return out;
}
