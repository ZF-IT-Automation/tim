import type { Edge, Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { projectDisplayNameFromEntry } from './project-display.js';
import { newestSubstantiveSession, substantiveSessionsSince } from './newest-substantive-session.js';

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

/** Summaries shown per neighbour before the overflow line. */
const NEIGHBOUR_SESSION_CAP = 3;
const NEIGHBOUR_SUMMARY_MAX_CHARS = 300;

export interface NeighbourActivity {
  label: string;
  displayName: string;
  /** Newest first, at most NEIGHBOUR_SESSION_CAP. */
  sessions: Array<{ date: string; summary: string }>;
  /** Summarized sessions beyond the cap. */
  more: number;
  /** Substantive sessions the summarizer has not reached yet. */
  unsummarized: number;
}

export interface CollectNeighbourActivityOptions {
  neighbours?: RelatedProjectInfo[];
  ownHead?: SubstantiveSessionHead | null;
}

function clipOneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * What happened in related projects since this project's newest substantive
 * session: summaries only. Neighbour handoff notes are next-steps for another
 * repo and are never returned.
 */
export async function collectNeighbourActivity(
  store: TimStore,
  projectLabel: string,
  options: CollectNeighbourActivityOptions = {},
): Promise<NeighbourActivity[]> {
  const neighbours = options.neighbours ?? await listRelatedProjects(store, projectLabel);
  if (neighbours.length === 0) return [];

  const own = options.ownHead !== undefined
    ? options.ownHead
    : await findNewestSubstantiveSession(store, projectLabel);
  const since = own?.lastActivity ?? '';
  const out: NeighbourActivity[] = [];

  for (const n of neighbours) {
    const newer = await substantiveSessionsSince(store, n.label, since);
    const summarized = newer.filter(s => s.summary);
    if (newer.length === 0) continue;
    out.push({
      label: n.label,
      displayName: n.displayName,
      sessions: summarized.slice(0, NEIGHBOUR_SESSION_CAP).map(s => ({
        date: s.date.slice(0, 10),
        summary: clipOneLine(s.summary, NEIGHBOUR_SUMMARY_MAX_CHARS),
      })),
      more: Math.max(0, summarized.length - NEIGHBOUR_SESSION_CAP),
      unsummarized: newer.length - summarized.length,
    });
  }

  return out;
}
