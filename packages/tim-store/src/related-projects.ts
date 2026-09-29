import type { Edge, Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { projectDisplayNameFromEntry } from './project-display.js';
import { newestSubstantiveSession } from './newest-substantive-session.js';

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

function isRelatedPairEdge(edge: Edge, aId: string, bId: string): boolean {
  return edge.type === RELATED_EDGE_TYPE
    && ((edge.sourceId === aId && edge.targetId === bId)
      || (edge.sourceId === bId && edge.targetId === aId));
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
  const matches = edgesA.filter(e => isRelatedPairEdge(e, a.id, b.id));
  if (matches.length === 0) return false;
  for (const edge of matches) {
    await store.unlink(edge.id);
  }
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

/** @deprecated Prefer `newestSubstantiveSession` for handoff-aware selection. */
export async function findNewestSubstantiveSession(
  store: TimStore,
  projectLabel: string,
): Promise<SubstantiveSessionHead | null> {
  const found = await newestSubstantiveSession(store, projectLabel);
  if (!found) return null;
  return {
    sessionId: found.sessionId,
    date: found.date,
    lastActivity: found.lastActivity,
  };
}

export interface NewerNeighbourHandoff {
  label: string;
  displayName: string;
  date: string;
  handoffNote: string;
}

export interface CollectNewerNeighbourHandoffsOptions {
  neighbours?: RelatedProjectInfo[];
  ownHead?: SubstantiveSessionHead | null;
}

export async function collectNewerNeighbourHandoffs(
  store: TimStore,
  projectLabel: string,
  maxNoteChars: number,
  options: CollectNewerNeighbourHandoffsOptions = {},
): Promise<NewerNeighbourHandoff[]> {
  const neighbours = options.neighbours ?? await listRelatedProjects(store, projectLabel);
  if (neighbours.length === 0) return [];

  const own = options.ownHead !== undefined
    ? options.ownHead
    : await findNewestSubstantiveSession(store, projectLabel);
  const ownActivity = own?.lastActivity ?? '';
  const out: NewerNeighbourHandoff[] = [];

  for (const n of neighbours) {
    const theirs = await newestSubstantiveSession(store, n.label);
    if (!theirs) continue;
    if (ownActivity && theirs.lastActivity <= ownActivity) continue;

    const note = theirs.handoffNote;
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
