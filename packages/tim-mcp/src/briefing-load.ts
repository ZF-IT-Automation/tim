import type { Entry } from 'tim-core';
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

  const topLevel = (await store.getChildren(project.id))
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

  for (const section of topLevel) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const batch = await store.loadProject(label, {
      depth: options.depth,
      budget: remaining,
      sections: [section.title],
    });
    if (!batch) continue;
    for (const child of batch.children) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        children.push(child);
      }
    }
    truncated = truncated || batch.truncated;
    remaining = Math.max(0, options.budget - children.length);
  }

  return { project, children, truncated };
}
