import { resolveEntrySearchStatus, type Entry } from 'tim-core';
import type { LoadProjectResult, TimStore } from 'tim-store';
import { LOG_SECTION_NAMES } from './task-aware-selection.js';

const COMMITS_KIND = 'commits-root';

function isLogSection(title: string): boolean {
  return LOG_SECTION_NAMES.has(title.toLowerCase());
}

/** Lower = loaded earlier and protected from later entry-budget starvation. */
function sectionLoadPriority(entry: Entry): number {
  const kind = entry.metadata.kind;
  if (kind === 'sessions-root') return 0;
  const lower = entry.title.toLowerCase();
  if (lower.includes('rule') || lower === 'rules' || lower === 'agent rules') return 1;
  if (lower === 'tasks' || lower === 'next steps') return 2;
  if (isLogSection(entry.title)) return 99;
  return 50;
}

function compareSectionOrder(a: Entry, b: Entry): number {
  const ao = Number(a.metadata.order);
  const bo = Number(b.metadata.order);
  const aOrder = Number.isFinite(ao) ? ao : 999999;
  const bOrder = Number.isFinite(bo) ? bo : 999999;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.createdAt.localeCompare(b.createdAt);
}

function compareBriefingEntries(a: Entry, b: Entry): number {
  const importance = (entry: Entry): number => {
    if (entry.metadata.kind === 'session-summary-root') return -10;
    if (entry.metadata.kind === 'exchanges-root') return 10;
    const status = resolveEntrySearchStatus(entry.metadata);
    if (status && ['done', 'cancelled', 'closed', 'fixed', 'resolved'].includes(status)) return 5;
    const task = entry.metadata.task;
    if (task && typeof task === 'object') {
      const priority = (task as Record<string, unknown>).priority;
      return priority === 'high' ? -3 : priority === 'medium' ? -2 : -1;
    }
    return 0;
  };
  if (a.metadata.kind === 'session' && b.metadata.kind === 'session') {
    return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  }
  return importance(a) - importance(b) || compareSectionOrder(a, b);
}

/**
 * Load a project for briefing render with reserved sections fetched before Log
 * volume can consume the entry budget. Preserves the caller's explicit budget.
 */
export async function loadProjectForBriefing(
  store: TimStore,
  label: string,
  options: { depth: number; budget: number; sections?: string[] | null },
): Promise<LoadProjectResult | null> {
  if (options.sections?.length) {
    return store.loadProject(label, options);
  }

  const resolved = await store.resolveProjectLabel(label);
  if (resolved.status !== 'found') return null;
  const project = await store.read(resolved.label);
  if (!project) return null;

  const topLevel = (await store.getChildren(project.id, { enforceSuppression: true }))
    .filter(c => c.metadata.kind !== COMMITS_KIND)
    .sort((a, b) => {
      const pd = sectionLoadPriority(a) - sectionLoadPriority(b);
      return pd !== 0 ? pd : compareSectionOrder(a, b);
    });

  if (topLevel.length === 0) {
    return store.loadProject(label, options);
  }

  const children: Entry[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let remaining = options.budget;

  for (const [index, section] of topLevel.entries()) {
    if (!seen.has(section.id)) {
      seen.add(section.id);
      children.push(section);
      remaining = Math.max(0, options.budget - children.length);
    }
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    // Reserve a share for every remaining protected section. A huge Sessions or
    // Rules section must not consume the entire budget before open work is read.
    const protectedRemaining = topLevel.slice(index).filter(entry => sectionLoadPriority(entry) < 50).length;
    const quota = sectionLoadPriority(section) < 50
      ? Math.max(1, Math.floor(remaining / Math.max(1, protectedRemaining))) : remaining;
    const queue = [{ entry: section, depth: 1 }];
    let taken = 0;
    while (queue.length && taken < quota) {
      const next = queue.shift()!;
      const child = next.entry;
      if (!seen.has(child.id)) {
        seen.add(child.id);
        children.push(child);
        taken++;
      }
      if (next.depth < options.depth) {
        const descendants = (await store.getChildren(child.id, { enforceSuppression: true }))
          .sort(compareBriefingEntries);
        // Session summary children are needed before the next older session.
        const pending = descendants.map(entry => ({ entry, depth: next.depth + 1 }));
        if (child.metadata.kind === 'session') queue.unshift(...pending);
        else queue.push(...pending);
      }
    }
    truncated = truncated || queue.length > 0;
    remaining = Math.max(0, options.budget - children.length);
  }

  return { project, children, truncated };
}
