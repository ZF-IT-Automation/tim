import type { Entry } from 'tim-core';
import type { LoadProjectResult } from 'tim-store';
import { isTaskMarker } from 'tim-store';
import { DEFAULT_BRIEFING_RECENT_SESSIONS } from 'tim-hooks';
import { resolveEntryTaskStatus } from './task-status.js';

const FORMAT_SEP = '─'.repeat(40);

export interface ProjectSchemaSection {
  name: string;
  description?: string;
  render_depth?: number | 'full';
  render_tail?: boolean;
  children?: ProjectSchemaSection[];
}

export interface ProjectSchema {
  sections: ProjectSchemaSection[];
}

function truncText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  // Break on the last word boundary rather than mid-word ("stealth, su…"),
  // unless that would drop too much (then hard-cut).
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + '…';
}

interface ParsedProjectHeader {
  title: string;
  status: string;
  description: string;
  packages?: number;
  tests?: number;
}

function parseProjectContent(title: string, content: string): ParsedProjectHeader {
  const combined = content ? `${title}\n${content}` : title;
  const parts = combined.split('|').map(p => p.trim());
  const headerTitle = parts[0] || title;
  const status = parts[1] || 'Unknown';
  const rest = parts.length > 3 ? parts.slice(3).join(' | ') : parts.slice(1).join(' | ');
  const packagesMatch = combined.match(/(\d+)[-\s]Package/i);
  const testsMatch =
    combined.match(/\((\d+)\s+tests?\)/i) ?? combined.match(/\b(\d+)\s+tests?\b/i);
  return {
    title: headerTitle,
    status,
    description: truncText(rest || combined, 300),
    packages: packagesMatch ? parseInt(packagesMatch[1], 10) : undefined,
    tests: testsMatch ? parseInt(testsMatch[1], 10) : undefined,
  };
}

function projectMetaLine(project: Entry, parsed: ParsedProjectHeader): string {
  const date = String(project.metadata.updated_at ?? project.createdAt).slice(0, 10);
  const bits = [`Status: ${parsed.status}`, date];
  if (parsed.packages != null) bits.push(`${parsed.packages} packages`);
  if (parsed.tests != null) bits.push(`${parsed.tests} tests`);
  return bits.join(' · ');
}

function entryTitle(entry: Entry): string {
  const title = entry.title.trim();
  if (title) return title;
  const first = entry.content.split('\n')[0]?.trim();
  return first || 'Untitled';
}

function sectionPreview(entry: Entry): string {
  return entry.content.trim();
}

function isEmptyBody(entry: Entry): boolean {
  return sectionPreview(entry) === '';
}

// A session summary is an LLM-condensed rollup (a handful of bullets), not a
// headline: 400 chars cut it mid-thought. Sized for a full condensed rollup.
const SESSION_SUMMARY_MAX = 1500;

// Only dedup section bodies with real substance — short/empty bodies ("No entries",
// a one-line preview) may coincidentally match and shouldn't collapse.
const DEDUP_MIN_CHARS = 80;

const ELIDED_MARKER = '…';

/**
 * Clamp a session summary while keeping its line structure. When it does not fit,
 * drop from the middle rather than the tail — the last bullets carry the handoff
 * ("next: …"), which is exactly what the next session needs.
 */
function clampSummaryLines(text: string, max: number): string[] {
  const lines = text
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter(l => l.length > 0);
  if (lines.length === 0) return [];

  const cost = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, -1);
  if (cost(lines) <= max) return lines;

  // Single blob (no line structure to preserve) — keep head and tail around the marker.
  if (lines.length === 1) {
    const only = lines[0];
    const head = Math.max(0, Math.floor(max * 0.5));
    const tail = Math.max(0, max - head - ELIDED_MARKER.length);
    return [`${only.slice(0, head).trimEnd()} ${ELIDED_MARKER} ${only.slice(only.length - tail).trimStart()}`];
  }

  // First line is the topic; then fill backwards from the newest content.
  const head = lines[0];
  const tail: string[] = [];
  let used = head.length + 1 + ELIDED_MARKER.length + 1;
  for (let i = lines.length - 1; i >= 1; i--) {
    const next = lines[i].length + 1;
    if (used + next > max) break;
    used += next;
    tail.unshift(lines[i]);
  }
  return tail.length > 0 ? [head, ELIDED_MARKER, ...tail] : [head, ELIDED_MARKER];
}

function parseSessionEntry(entry: Entry): { exchanges: number; summary: string[]; date: string } {
  const date = entry.createdAt.slice(0, 10);
  const combined = entry.content ? `${entry.title}\n${entry.content}` : entry.title;
  const exMatch = combined.match(/(\d+)\s+exchanges?/i);

  // Prefer the structured metadata the store maintains (rollUpSession/updateSessionSummary
  // set metadata.exchanges + metadata.summary); the body regex is only a legacy fallback.
  const metaExchanges = Number(entry.metadata.exchanges);
  const exchanges = Number.isFinite(metaExchanges) && metaExchanges > 0
    ? metaExchanges
    : exMatch ? parseInt(exMatch[1], 10) : 0;

  const metaSummary = typeof entry.metadata.summary === 'string' ? entry.metadata.summary.trim() : '';
  let summary = metaSummary || combined;
  if (!metaSummary && exMatch) {
    summary = combined.replace(/\s*[—–-]\s*\d+\s+exchanges?.*$/i, '').trim();
  }
  return { exchanges, summary: clampSummaryLines(summary, SESSION_SUMMARY_MAX), date };
}

function compareEntryOrder(a: Entry, b: Entry): number {
  const oa = Number(a.metadata.order);
  const ob = Number(b.metadata.order);
  const orderA = Number.isFinite(oa) ? oa : 999999;
  const orderB = Number.isFinite(ob) ? ob : 999999;
  if (orderA !== orderB) return orderA - orderB;
  return a.createdAt.localeCompare(b.createdAt);
}

function buildChildMap(children: Entry[]): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  for (const child of children) {
    if (!child.parentId) continue;
    const list = map.get(child.parentId);
    if (list) list.push(child);
    else map.set(child.parentId, [child]);
  }
  for (const list of map.values()) {
    list.sort(compareEntryOrder);
  }
  return map;
}

function childCountLabel(count: number): string {
  return count === 1 ? '[1 subnode]' : `[${count} subnodes]`;
}

function sectionContentBody(section: Entry): string {
  if (isEmptyBody(section)) return '';
  return truncText(sectionPreview(section), 200);
}

function isBugEntry(entry: Entry): boolean {
  if (entry.tags.some(t => t === '#bug' || t === 'bug')) return true;
  if (String(entry.metadata.type ?? '') === 'bug') return true;
  const bug = entry.metadata.bug;
  return bug !== null && typeof bug === 'object' && !Array.isArray(bug);
}

function resolveBugStatus(entry: Entry): string {
  const bug = entry.metadata.bug;
  if (typeof bug === 'object' && bug !== null && !Array.isArray(bug)) {
    const st = (bug as { status?: unknown }).status;
    if (typeof st === 'string' && st) return st;
  }
  if (String(entry.metadata.type ?? '') === 'bug' && typeof entry.metadata.status === 'string') {
    return entry.metadata.status;
  }
  return 'open';
}

function resolveBugSeverity(entry: Entry): string | undefined {
  const bug = entry.metadata.bug;
  if (typeof bug === 'object' && bug !== null && !Array.isArray(bug)) {
    const sev = (bug as { severity?: unknown }).severity;
    if (typeof sev === 'string' && sev) return sev;
  }
  if (typeof entry.metadata.severity === 'string' && entry.metadata.severity) {
    return entry.metadata.severity;
  }
  return undefined;
}

function entryBadge(entry: Entry): string {
  if (isTaskMarker(entry.metadata.task)) {
    const status = resolveEntryTaskStatus(entry.metadata);
    return ` [${status}]`;
  }
  if (isBugEntry(entry)) {
    const status = resolveBugStatus(entry);
    const severity = resolveBugSeverity(entry);
    const parts = severity ? [status, severity] : [status];
    return ` [${parts.join(' · ')}]`;
  }
  if (entry.metadata.kind === 'error') {
    return ` [${entry.metadata.severity || 'medium'}]`;
  }
  return '';
}

function entryBodyPreview(entry: Entry): string {
  if (!isTaskMarker(entry.metadata.task) && !isBugEntry(entry)) {
    return '';
  }
  return truncText(sectionPreview(entry), 120);
}

interface FormatBudget {
  remaining: number;
}

const MAX_CHILDREN_PER_LEVEL = 10;
const MAX_CHILDREN_PROTECTED_SECTIONS = 50;
const PROTECTED_CHILD_SECTIONS = new Set(['Bugs', 'Next Steps']);
const PROJECT_SUMMARY_MARKER = '## Project Summary';
// Fallback only — callers pass the configured value (briefing.recentSessions).
const RECENT_SESSIONS_COUNT = DEFAULT_BRIEFING_RECENT_SESSIONS;

const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled']);
const CLOSED_BUG_STATUSES = new Set(['fixed', 'closed', 'resolved', 'wontfix', 'done']);

const TASK_STATUS_SORT: Record<string, number> = {
  in_progress: 0,
  changes_pending: 0,
  pushed: 1,
  reviewed: 1,
  todo: 2,
};
const TASK_PRIORITY_SORT: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const BUG_SEVERITY_SORT: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function getTaskMeta(entry: Entry): { priority?: string; due?: string; order?: number } {
  const task = entry.metadata.task;
  if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
    const tm = task as Record<string, unknown>;
    const order = Number(tm.order);
    return {
      priority: typeof tm.priority === 'string' ? tm.priority : undefined,
      due: typeof tm.due === 'string' ? tm.due
        : typeof tm.due_date === 'string' ? tm.due_date
          : undefined,
      order: Number.isFinite(order) ? order : undefined,
    };
  }
  return {};
}

function isClosedTask(entry: Entry): boolean {
  if (!isTaskMarker(entry.metadata.task)) return false;
  return CLOSED_TASK_STATUSES.has(resolveEntryTaskStatus(entry.metadata));
}

function isClosedBug(entry: Entry): boolean {
  if (!isBugEntry(entry)) return false;
  return CLOSED_BUG_STATUSES.has(resolveBugStatus(entry));
}

function compareTaskEntries(a: Entry, b: Entry): number {
  const metaA = getTaskMeta(a);
  const metaB = getTaskMeta(b);
  const orderA = metaA.order ?? 999999;
  const orderB = metaB.order ?? 999999;
  if (orderA !== orderB) return orderA - orderB;

  const statusA = TASK_STATUS_SORT[resolveEntryTaskStatus(a.metadata)] ?? 3;
  const statusB = TASK_STATUS_SORT[resolveEntryTaskStatus(b.metadata)] ?? 3;
  if (statusA !== statusB) return statusA - statusB;

  const priorityA = TASK_PRIORITY_SORT[metaA.priority ?? ''] ?? 3;
  const priorityB = TASK_PRIORITY_SORT[metaB.priority ?? ''] ?? 3;
  if (priorityA !== priorityB) return priorityA - priorityB;

  if (!metaA.due && !metaB.due) return compareEntryOrder(a, b);
  if (!metaA.due) return 1;
  if (!metaB.due) return -1;
  const dueCmp = metaA.due.localeCompare(metaB.due);
  return dueCmp !== 0 ? dueCmp : compareEntryOrder(a, b);
}

function compareBugEntries(a: Entry, b: Entry): number {
  const openA = isClosedBug(a) ? 1 : 0;
  const openB = isClosedBug(b) ? 1 : 0;
  if (openA !== openB) return openA - openB;

  const sevA = BUG_SEVERITY_SORT[resolveBugSeverity(a) ?? ''] ?? 4;
  const sevB = BUG_SEVERITY_SORT[resolveBugSeverity(b) ?? ''] ?? 4;
  if (sevA !== sevB) return sevA - sevB;

  return compareEntryOrder(a, b);
}

interface PreparedSectionChildren {
  visible: Entry[];
  collapsedCount: number;
  collapsedLabel: string;
}

function prepareSectionChildren(children: Entry[], sectionName: string): PreparedSectionChildren {
  if (sectionName === 'Next Steps') {
    const tasks = children.filter(c => isTaskMarker(c.metadata.task));
    const active = tasks.filter(c => !isClosedTask(c)).sort(compareTaskEntries);
    const collapsed = tasks.filter(c => isClosedTask(c));
    return {
      visible: active,
      collapsedCount: collapsed.length,
      collapsedLabel: collapsed.length === 1
        ? '1 completed task (done/cancelled)'
        : `${collapsed.length} completed tasks (done/cancelled)`,
    };
  }

  if (sectionName === 'Tasks') {
    const tasks = children.filter(c => isTaskMarker(c.metadata.task));
    const nonTasks = children.filter(c => !isTaskMarker(c.metadata.task));
    const active = tasks.filter(c => !isClosedTask(c)).sort(compareTaskEntries);
    const collapsed = tasks.filter(c => isClosedTask(c));
    return {
      visible: [...active, ...nonTasks.sort(compareEntryOrder)],
      collapsedCount: collapsed.length,
      collapsedLabel: collapsed.length === 1
        ? '1 completed task (done/cancelled)'
        : `${collapsed.length} completed tasks (done/cancelled)`,
    };
  }

  if (sectionName === 'Bugs') {
    const bugs = children.filter(c => isBugEntry(c));
    const nonBugs = children.filter(c => !isBugEntry(c));
    const open = bugs.filter(c => !isClosedBug(c)).sort(compareBugEntries);
    const closed = bugs.filter(c => isClosedBug(c)).sort(compareBugEntries);
    return {
      visible: [...open, ...closed, ...nonBugs.sort(compareEntryOrder)],
      collapsedCount: 0,
      collapsedLabel: '',
    };
  }

  return { visible: children, collapsedCount: 0, collapsedLabel: '' };
}

function maxChildrenForSection(sectionName?: string): number {
  if (sectionName && PROTECTED_CHILD_SECTIONS.has(sectionName)) {
    return MAX_CHILDREN_PROTECTED_SECTIONS;
  }
  return MAX_CHILDREN_PER_LEVEL;
}

function normalizeRenderDepth(value: unknown): number | 'full' | undefined {
  if (value === 'full') return 'full';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (value === 'full') return 'full';
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function resolveRenderDepth(
  entry: Entry,
  schemaDefault?: number | 'full',
  renderMode?: 'load' | 'read',
): number | 'full' {
  // Per-node metadata override (new camelCase fields first, then legacy render_depth)
  if (renderMode === 'load') {
    const loadOverride = normalizeRenderDepth(entry.metadata.renderDepthLoad);
    if (loadOverride !== undefined) return loadOverride;
  } else if (renderMode === 'read') {
    const readOverride = normalizeRenderDepth(entry.metadata.renderDepthRead);
    if (readOverride !== undefined) return readOverride;
  }
  const legacyOverride = normalizeRenderDepth(entry.metadata.render_depth);
  if (legacyOverride !== undefined) return legacyOverride;
  if (schemaDefault !== undefined) return schemaDefault;
  return 1;
}

function resolveRenderTail(entry: Entry, schemaDefault?: boolean): boolean {
  const override = entry.metadata.render_tail;
  if (typeof override === 'boolean') return override;
  if (override === 'true') return true;
  if (override === 'false') return false;
  if (schemaDefault !== undefined) return schemaDefault;
  return false;
}

function findSchemaSection(
  sections: ProjectSchemaSection[] | undefined,
  name: string,
): ProjectSchemaSection | undefined {
  if (!sections?.length) return undefined;
  for (const section of sections) {
    if (section.name === name) return section;
    const nested = findSchemaSection(section.children, name);
    if (nested) return nested;
  }
  return undefined;
}

function shouldRenderChildren(depth: number | 'full'): boolean {
  return depth !== 0;
}

function maxChildDepth(depth: number | 'full'): number {
  if (depth === 'full') return Number.MAX_SAFE_INTEGER;
  return Math.max(0, depth);
}

function formatChildrenTree(
  children: Entry[],
  childMap: Map<string, Entry[]>,
  depth: number,
  budget: FormatBudget,
  schema?: ProjectSchema,
  renderTail?: boolean,
  renderMode?: 'load' | 'read',
  sectionName?: string,
  collapsed?: Pick<PreparedSectionChildren, 'collapsedCount' | 'collapsedLabel'>,
): string[] {
  if (children.length === 0 || budget.remaining <= 0) return [];

  const lines: string[] = [];
  const indent = ' '.repeat(4 + depth * 2);
  const maxChildren = maxChildrenForSection(sectionName);
  const maxShow = Math.min(maxChildren, children.length);
  // renderTail → show the LAST maxShow children (still in ascending order)
  const indices = renderTail
    ? Array.from({ length: maxShow }, (_, i) => children.length - maxShow + i)
    : Array.from({ length: maxShow }, (_, i) => i);
  let shown = 0;

  for (const i of indices) {
    if (budget.remaining <= 0) break;
    const child = children[i];
    const childSchema = findSchemaSection(schema?.sections, entryTitle(child));
    const childRenderDepth = resolveRenderDepth(child, childSchema?.render_depth, renderMode);

    // renderDepth=0 → skip node AND entire subtree entirely
    if (childRenderDepth === 0) {
      continue;
    }

    lines.push(`${indent}${entryTitle(child)}${entryBadge(child)}`);
    budget.remaining -= 1;

    const preview = entryBodyPreview(child);
    if (preview) {
      lines.push(`${indent}  ${preview}`);
    }
    shown += 1;

    const subkids = childMap.get(child.id) ?? [];
    if (subkids.length > 0 && shouldRenderChildren(childRenderDepth)) {
      const nextDepth = maxChildDepth(childRenderDepth);
      if (nextDepth > 0) {
        lines.push(...formatChildrenTree(subkids, childMap, depth + 1, budget, schema, undefined, renderMode));
      }
    }
  }

  const hidden = children.length - shown;
  if (hidden > 0 && budget.remaining > 0) {
    lines.push(`${indent}… ${hidden} more${renderTail ? ' (older)' : ''}`);
    budget.remaining -= 1;
  }

  if (collapsed && collapsed.collapsedCount > 0 && budget.remaining > 0) {
    lines.push(`${indent}… ${collapsed.collapsedLabel}`);
    budget.remaining -= 1;
  }

  return lines;
}

function formatSectionLineSuffix(
  section: Entry,
  subkids: Entry[],
  renderDepth: number | 'full',
): string {
  if (subkids.length > 0 && !shouldRenderChildren(renderDepth)) {
    return childCountLabel(subkids.length);
  }
  return sectionContentBody(section);
}

export function formatProjectOutput(
  result: LoadProjectResult,
  budget: number,
  schema?: ProjectSchema,
  renderMode?: 'load' | 'read',
  recentSessionsCount: number = RECENT_SESSIONS_COUNT,
): string {
  const { project, children, truncated } = result;
  const label = String(project.metadata.label ?? project.id);
  // Strip the auto-generated Project Summary out before parsing the header,
  // so it never leaks into the description / packages / tests counts.
  const summaryMatch = project.content.match(
    /## Project Summary\s*\n([\s\S]*?)(?=\n## |\n── |$)/,
  );
  const projectSummary = summaryMatch ? summaryMatch[1].trim() : '';
  const contentForParse = project.content.split(PROJECT_SUMMARY_MARKER)[0].trimEnd();
  const parsed = parseProjectContent(project.title, contentForParse);
  const lines: string[] = [];
  const childMap = buildChildMap(children);
  const budgetState: FormatBudget = { remaining: budget };

  lines.push(FORMAT_SEP);
  lines.push(`${label} — ${parsed.title}`);
  lines.push(FORMAT_SEP);
  lines.push(projectMetaLine(project, parsed));

  const tags = project.tags.map(t => (t.startsWith('#') ? t : `#${t}`)).join(' ');
  if (tags) lines.push(`Tags: ${tags}`);

  const access = project.metadata.access_count ?? 0;
  lines.push(`Access: ${access}`);

  if (parsed.description) {
    lines.push('', parsed.description);
  }

  if (projectSummary) {
    lines.push('', '── Project Summary ──', '', projectSummary);
  }

  const sections = children
    .filter(c =>
      c.parentId === project.id &&
      !c.tags.includes('#session-summary') &&
      c.metadata.kind !== 'commits-root' &&
      c.metadata.kind !== 'sessions-root',
    )
    .sort(compareEntryOrder);

  const sessions = children
    .filter(c => c.tags.includes('#session-summary'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (sections.length > 0) {
    lines.push('', `── Sections (${sections.length}) ──`, '');
    // Non-destructive cross-section dedup: two sections whose rendered body is
    // identical (e.g. an import that duplicated a subtree) are shown once; the
    // repeat collapses to a reference so a resuming agent sees the relationship
    // without re-reading — and the render budget spent on the discarded body is
    // refunded so it isn't charged twice.
    const seenBodies = new Map<string, string>();
    for (const section of sections) {
      const name = entryTitle(section);
      const schemaSection = findSchemaSection(schema?.sections, name);
      const renderDepth = resolveRenderDepth(section, schemaSection?.render_depth, renderMode);

      // renderDepth=0 → skip entire section node + subtree
      if (renderDepth === 0) {
        continue;
      }

      const useTail = resolveRenderTail(section, schemaSection?.render_tail);
      const rawSubkids = childMap.get(section.id) ?? [];
      const prepared = prepareSectionChildren(rawSubkids, name);
      const subkids = prepared.visible;

      // Render the body into a temp buffer first, so an identical body can be deduped.
      const budgetBefore = budgetState.remaining;
      const body: string[] = [];
      if (subkids.length > 0 && !shouldRenderChildren(renderDepth)) {
        body.push(`    ${childCountLabel(subkids.length)}`);
      } else {
        const content = sectionContentBody(section);
        if (content) {
          body.push(`    ${content}`);
        } else if (subkids.length === 0 && prepared.collapsedCount === 0) {
          body.push(`    No entries`);
        }
        if ((subkids.length > 0 || prepared.collapsedCount > 0) && shouldRenderChildren(renderDepth)) {
          const nextDepth = maxChildDepth(renderDepth);
          if (nextDepth > 0) {
            body.push(...formatChildrenTree(
              subkids,
              childMap,
              0,
              budgetState,
              schema,
              useTail,
              renderMode,
              name,
              prepared,
            ));
          }
        }
      }

      lines.push(`  ${name}`);
      const fingerprint = body.join('\n').trim();
      const dupOf = fingerprint.length >= DEDUP_MIN_CHARS ? seenBodies.get(fingerprint) : undefined;
      if (dupOf) {
        budgetState.remaining = budgetBefore; // refund — the duplicate body is discarded
        lines.push(`    (inhaltsgleich mit "${dupOf}" — nicht wiederholt)`);
      } else {
        if (fingerprint.length >= DEDUP_MIN_CHARS) seenBodies.set(fingerprint, name);
        lines.push(...body);
      }
    }
  }

  if (sessions.length > 0) {
    const shown = recentSessionsCount > 0 ? recentSessionsCount : RECENT_SESSIONS_COUNT;
    const recent = sessions.slice(0, shown);
    lines.push('', `── Recent Sessions (${recent.length}/${sessions.length}) ──`, '');
    for (const session of recent) {
      const { exchanges, summary, date } = parseSessionEntry(session);
      // Header line, then the summary's own lines indented — a condensed rollup is
      // multi-bullet and becomes unreadable when folded onto one line.
      lines.push(`  ${exchanges} exchanges · ${date}`);
      for (const line of summary) lines.push(`    ${line}`);
      if (summary.length === 0) lines.push('    (no summary)');
    }
    if (sessions.length > shown) {
      lines.push(`  … ${sessions.length - shown} older sessions`);
    }
  }

  lines.push('', FORMAT_SEP);
  lines.push(`children: ${children.length} · truncated: ${truncated}`);
  lines.push(`Use tim_read("${label}") to drill into any section.`);
  lines.push(FORMAT_SEP);

  return lines.join('\n');
}
