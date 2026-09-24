import type { Entry, ProjectSchema } from 'tim-core';
import { findSchemaSection, isClosedBugMetadata, resolveBugStatusFromMetadata, taskPriorityRank } from 'tim-core';
import type { LoadProjectResult } from 'tim-store';
import { isTaskMarker, SUMMARY_NODE_TITLE } from 'tim-store';
import { DEFAULT_BRIEFING_RECENT_SESSIONS, clampSummary } from 'tim-hooks';
import { resolveEntryTaskStatus } from './task-status.js';
import {
  BRIEFING_PRIORITY,
  assembleBoundedBriefingText,
  formatQueryExtrasBlock,
  logSectionOmission,
  sectionPriority,
  type BriefingBlock,
  LOG_SECTION_NAMES,
} from './task-aware-selection.js';

const LOG_SECTION_PREVIEW_MAX = 3;

export interface RecentSessionLine {
  exchanges: number;
  date: string;
  summary: string[];
}

export interface BriefingRenderContext {
  lastActivityDate?: string;
  nowBlockLines?: string[];
  recentSessions?: RecentSessionLine[];
  totalSessionCount?: number;
  hiddenShortSessionCount?: number;
  /** Open-task counts from store.getTasks — same source as the Now block. */
  openTaskCounts?: { open: number; stale: number };
  /** Open-bug count from store.getBugs — same source as the Sections index line. */
  openBugCount?: number;
}

export interface FormatProjectOutputOptions {
  /** When set, apply MCP render bounding; omit for legacy unbounded callers. */
  tokenBudget?: number;
  query?: string;
  queryExtras?: Entry[];
  /** Appended before whole-response bounding (e.g. load NEXT hint). */
  trailingSuffix?: string;
  briefingContext?: BriefingRenderContext;
  /** Explicit section filter from tim_load_project / tim_read_project. */
  requestedSections?: string[] | null;
}

// The schema shape and its traversal live in tim-core — the same definition the
// creation paths materialize from. Re-exported here so existing importers of
// './project-output.js' keep working.
export type { ProjectSchema, ProjectSchemaSection } from 'tim-core';

const FORMAT_SEP = '─'.repeat(40);
const RULE_LINE_MAX = 160;

/** Display order for tim_load_project blocks (lower = earlier). */
const LOAD_BLOCK_ORDER = {
  header: 0,
  now: 10,
  rules: 20,
  projectSummary: 30,
  sectionsIndex: 40,
  sectionBodyBase: 100,
  recentSessions: 950,
  footer: 9999,
} as const;

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
  /** True when the project title uses the `Title | Status | …` pipe segment. */
  hasKnownStatus: boolean;
  description: string;
  packages?: number;
  tests?: number;
}

function parseProjectContent(title: string, content: string): ParsedProjectHeader {
  const titleParts = title.split('|').map(p => p.trim());
  const hasKnownStatus = titleParts.length >= 2 && Boolean(titleParts[1]);
  const combined = content ? `${title}\n${content}` : title;
  const parts = combined.split('|').map(p => p.trim());
  const headerTitle = titleParts[0] || parts[0] || title;
  const status = hasKnownStatus ? titleParts[1]! : 'Unknown';
  const rest = parts.length > 3 ? parts.slice(3).join(' | ') : parts.slice(1).join(' | ');
  const packagesMatch = combined.match(/(\d+)[-\s]Package/i);
  const testsMatch =
    combined.match(/\((\d+)\s+tests?\)/i) ?? combined.match(/\b(\d+)\s+tests?\b/i);
  return {
    title: headerTitle,
    status,
    hasKnownStatus,
    description: truncText(rest || combined, 300),
    packages: packagesMatch ? parseInt(packagesMatch[1], 10) : undefined,
    tests: testsMatch ? parseInt(testsMatch[1], 10) : undefined,
  };
}

/**
 * tim_load_project header meta line grammar (stable prefix for parsers):
 * - Known status:  `Status: <status> · last activity <YYYY-MM-DD>[ · <n> packages][ · <n> tests]`
 * - Unknown status: `last activity <YYYY-MM-DD>[ · <n> packages][ · <n> tests]` (no Status segment)
 */
function projectMetaLine(
  project: Entry,
  parsed: ParsedProjectHeader,
  lastActivity?: string,
): string {
  const date = (lastActivity ?? String(project.metadata.updated_at ?? project.createdAt)).slice(0, 10);
  const bits: string[] = [];
  if (parsed.hasKnownStatus) bits.push(`Status: ${parsed.status}`);
  bits.push(`last activity ${date}`);
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

function isOverviewSection(section: Entry): boolean {
  const title = entryTitle(section);
  return title.toLowerCase() === 'overview'
    || (section.metadata.kind === 'section' && title === 'Overview');
}

function isTasksSection(section: Entry): boolean {
  return entryTitle(section) === 'Tasks';
}

function isRulesSection(section: Entry): boolean {
  return entryTitle(section).toLowerCase() === 'rules';
}

function isBugsSection(section: Entry): boolean {
  return entryTitle(section) === 'Bugs';
}

const STALE_TASK_DAYS = 14;

function isTaskStale(updatedAt: string): boolean {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return false;
  return (Date.now() - updatedMs) / 86400_000 > STALE_TASK_DAYS;
}

function countOpenTasks(children: Entry[]): { open: number; stale: number } {
  let open = 0;
  let stale = 0;
  for (const child of children) {
    if (!isTaskMarker(child.metadata.task)) continue;
    if (isClosedTask(child)) continue;
    open += 1;
    if (isTaskStale(child.updatedAt)) stale += 1;
  }
  return { open, stale };
}

function countOpenBugs(children: Entry[]): number {
  let open = 0;
  for (const child of children) {
    if (!isBugEntry(child)) continue;
    if (!isClosedBug(child)) open += 1;
  }
  return open;
}

function ruleCompactLine(entry: Entry): string {
  const title = entryTitle(entry);
  const body = sectionPreview(entry);
  const bodyLines = body
    .split('\n')
    .map(line => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(line => line.length > 0);
  // A body that only restates the title ("X" / "X." / "X:") adds nothing.
  const same = (a: string, b: string) => a.replace(/[.:\s]+$/, '') === b.replace(/[.:\s]+$/, '');
  const firstBody = bodyLines.find(line => !same(line, title)) ?? '';

  let text: string;
  if (title !== 'Untitled' && firstBody) {
    text = `${title}: ${firstBody}`;
  } else if (firstBody) {
    text = firstBody;
  } else if (title !== 'Untitled') {
    text = title;
  } else {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  const overLimit = normalized.length > RULE_LINE_MAX;
  text = overLimit ? truncText(normalized, RULE_LINE_MAX) : normalized;

  const hasMoreBody = bodyLines.length > 1
    || body.replace(/\s+/g, ' ').trim().length > RULE_LINE_MAX;
  if (hasMoreBody || overLimit) {
    text += ` — tim_read("${entry.id}")`;
  }
  return text;
}

function renderRulesBlock(section: Entry, childMap: Map<string, Entry[]>): string[] {
  const lines: string[] = [];
  const sectionLine = ruleCompactLine(section);
  if (sectionLine) lines.push(sectionLine);
  const children = childMap.get(section.id) ?? [];
  let superseded = 0;
  for (const child of children) {
    // Rules kept for history ("[superseded …]") are not binding; list them as a count only.
    if (/^\[superseded/i.test(entryTitle(child).trim())) {
      superseded += 1;
      continue;
    }
    const line = ruleCompactLine(child);
    if (line) lines.push(line);
  }
  if (superseded > 0) {
    lines.push(`(+ ${superseded} superseded rule${superseded === 1 ? '' : 's'} kept for history — tim_read("${section.id}"))`);
  }
  return lines;
}

function overviewPreviewLines(content: string, maxLines = 5): string {
  return content
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .slice(0, maxLines)
    .join('\n');
}

function rootBodyFirstParagraph(content: string, maxLines = 5): string {
  const withoutSummary = content.split(PROJECT_SUMMARY_MARKER)[0] ?? content;
  const withoutHeadings = withoutSummary.replace(/^#{1,6}\s+.*$/gm, '').trim();
  const firstParagraph = withoutHeadings.split(/\n\s*\n/)[0] ?? withoutHeadings;
  return overviewPreviewLines(firstParagraph, maxLines);
}

function overviewNeedsReadPointer(section: Entry, childMap: Map<string, Entry[]>): boolean {
  const subkids = childMap.get(section.id) ?? [];
  if (subkids.length > 0) return true;
  const lineCount = sectionPreview(section)
    .split('\n')
    .filter(line => line.trim().length > 0)
    .length;
  return lineCount > 5;
}

function resolveProjectPreview(
  project: Entry,
  sections: Entry[],
): string {
  const overview = sections.find(isOverviewSection);
  if (overview && sectionPreview(overview).trim()) {
    return overviewPreviewLines(sectionPreview(overview));
  }
  const body = project.content.split(PROJECT_SUMMARY_MARKER)[0]?.trimEnd() ?? '';
  if (!body) return '';
  return rootBodyFirstParagraph(body);
}

/** Keep the head of a long project summary — the coverage line and first bullets matter most. */
function clampSummaryHead(text: string, maxChars: number): string {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  if (lines.length === 0) return '';
  const cost = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, -1);
  if (cost(lines) <= maxChars) return lines.join('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = line.length + 1;
    if (used + next > maxChars) break;
    used += next;
    kept.push(line);
  }
  return kept.length > 0 ? [...kept, '…'].join('\n') : '…';
}

function isNoEntriesOnlyBody(bodyLines: string[]): boolean {
  const nonEmpty = bodyLines.map(l => l.trim()).filter(Boolean);
  return nonEmpty.length === 1 && nonEmpty[0] === 'No entries';
}

function normalizeSectionFilterName(name: string): string {
  return name.trim().toLowerCase();
}

function sectionExplicitlyRequested(
  section: Entry,
  name: string,
  requested: Set<string>,
): boolean {
  if (requested.size === 0) return false;
  const lower = normalizeSectionFilterName(name);
  if (requested.has(lower)) return true;
  const label = typeof section.metadata.label === 'string'
    ? normalizeSectionFilterName(section.metadata.label)
    : '';
  return label.length > 0 && requested.has(label);
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

function parseSessionEntry(
  entry: Entry,
  sessionNode?: Entry,
): { exchanges: number; summary: string[]; date: string } {
  const date = entry.createdAt.slice(0, 10);
  // A freshly created summary node is the sentinel "Summary" with an empty body —
  // echoing it as the session's summary line says nothing. Legacy nodes that carry
  // their text in title/content still go through `combined`.
  const isSentinel = entry.title === SUMMARY_NODE_TITLE;
  const combined = entry.content
    ? (isSentinel ? entry.content : `${entry.title}\n${entry.content}`)
    : (isSentinel ? '' : entry.title);
  const exMatch = combined.match(/(\d+)\s+exchanges?/i);

  // The live count is the logger's `exchange_count` on the session node — the summary
  // node's `exchanges` stays 0 until the summarizer runs, which is what made every
  // brief report "0 exchanges" for a session that was logging fine.
  const liveCount = Number(sessionNode?.metadata.exchange_count);
  const metaExchanges = Number(entry.metadata.exchanges);
  const exchanges = Number.isFinite(liveCount) && liveCount > 0
    ? liveCount
    : Number.isFinite(metaExchanges) && metaExchanges > 0
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
  return resolveBugStatusFromMetadata(entry.metadata);
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
// Tasks inherits the higher cap that 'Next Steps' used to hold: the work queue
// moved there when that section was retired, and the default 10-child cap would
// hide most of it in the brief.
const PROTECTED_CHILD_SECTIONS = new Set(['Bugs', 'Tasks']);
const PROJECT_SUMMARY_MARKER = '## Project Summary';
// Fallback only — callers pass the configured value (briefing.recentSessions).
const RECENT_SESSIONS_COUNT = DEFAULT_BRIEFING_RECENT_SESSIONS;

const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled']);

const TASK_STATUS_SORT: Record<string, number> = {
  in_progress: 0,
  changes_pending: 0,
  pushed: 1,
  reviewed: 1,
  todo: 2,
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
  return isClosedBugMetadata(entry.metadata);
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

  const priorityA = taskPriorityRank(metaA.priority);
  const priorityB = taskPriorityRank(metaB.priority);
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

function prepareSectionChildren(
  children: Entry[],
  sectionName: string,
  sectionId?: string,
): PreparedSectionChildren {
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
    const readTarget = sectionId ?? sectionName;
    return {
      visible: [...open, ...nonBugs.sort(compareEntryOrder)],
      collapsedCount: closed.length,
      collapsedLabel: closed.length > 0
        ? `✓ ${closed.length} fixed — tim_read("${readTarget}")`
        : '',
    };
  }

  return { visible: children, collapsedCount: 0, collapsedLabel: '' };
}

function maxChildrenForSection(sectionName?: string, taskAware = false): number {
  if (sectionName && LOG_SECTION_NAMES.has(sectionName.toLowerCase()) && taskAware) {
    return LOG_SECTION_PREVIEW_MAX;
  }
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
  sectionId?: string,
  collapsed?: Pick<PreparedSectionChildren, 'collapsedCount' | 'collapsedLabel'>,
  taskAware = false,
): string[] {
  if (children.length === 0 || budget.remaining <= 0) return [];

  const lines: string[] = [];
  const indent = ' '.repeat(4 + depth * 2);
  const maxChildren = maxChildrenForSection(sectionName, taskAware);
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
        lines.push(...formatChildrenTree(
          subkids, childMap, depth + 1, budget, schema, undefined, renderMode,
          sectionName, sectionId,
        ));
      }
    }
  }

  const hidden = children.length - shown;
  if (hidden > 0 && budget.remaining > 0) {
    const expandTarget = sectionId ?? sectionName ?? 'section';
    if (taskAware && sectionName && LOG_SECTION_NAMES.has(sectionName.toLowerCase())) {
      lines.push(`${indent}${logSectionOmission(children.length, shown, expandTarget)}`);
    } else {
      lines.push(`${indent}… ${hidden} more — tim_read("${expandTarget}")${renderTail ? ' (older)' : ''}`);
    }
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

function renderSectionBody(
  section: Entry,
  name: string,
  childMap: Map<string, Entry[]>,
  budgetState: FormatBudget,
  schema: ProjectSchema | undefined,
  renderMode: 'load' | 'read' | undefined,
  seenBodies: Map<string, string>,
  taskAware: boolean,
): { header: string; bodyLines: string[]; order: number } | null {
  const schemaSection = findSchemaSection(schema?.sections, name);
  const renderDepth = resolveRenderDepth(section, schemaSection?.render_depth, renderMode);
  if (renderDepth === 0) return null;

  const useTail = resolveRenderTail(section, schemaSection?.render_tail);
  const rawSubkids = childMap.get(section.id) ?? [];
  const prepared = prepareSectionChildren(rawSubkids, name, section.id);
  const subkids = prepared.visible;
  const budgetBefore = budgetState.remaining;
  const body: string[] = [];

  if (subkids.length > 0 && !shouldRenderChildren(renderDepth)) {
    body.push(`    ${childCountLabel(subkids.length)}`);
  } else {
    const content = sectionContentBody(section);
    if (content) body.push(`    ${content}`);
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
          section.id,
          prepared,
          taskAware,
        ));
      }
    }
  }

  const header = `  ${name}`;
  const fingerprint = body.join('\n').trim();
  const dupOf = fingerprint.length >= DEDUP_MIN_CHARS ? seenBodies.get(fingerprint) : undefined;
  const bodyLines: string[] = [];
  if (dupOf) {
    budgetState.remaining = budgetBefore;
    bodyLines.push(`    (inhaltsgleich mit "${dupOf}" — nicht wiederholt)`);
  } else {
    if (fingerprint.length >= DEDUP_MIN_CHARS) seenBodies.set(fingerprint, name);
    bodyLines.push(...body);
  }

  const order = Number(section.metadata.order);
  return {
    header,
    bodyLines,
    order: Number.isFinite(order) ? order : 999999,
  };
}

function formatProjectOutputWithTokenBudget(
  result: LoadProjectResult,
  budget: number,
  schema: ProjectSchema | undefined,
  renderMode: 'load' | 'read' | undefined,
  recentSessionsCount: number,
  options: FormatProjectOutputOptions,
): string {
  const { project, children, truncated } = result;
  const label = String(project.metadata.label ?? project.id);
  const summaryMatch = project.content.match(
    /## Project Summary\s*\n([\s\S]*?)(?=\n## |\n── |$)/,
  );
  const projectSummary = summaryMatch ? summaryMatch[1].trim() : '';
  const contentForParse = project.content.split(PROJECT_SUMMARY_MARKER)[0].trimEnd();
  const parsed = parseProjectContent(project.title, contentForParse);
  const childMap = buildChildMap(children);
  const entryById = new Map(children.map(c => [c.id, c]));
  const budgetState: FormatBudget = { remaining: budget };
  const seenBodies = new Map<string, string>();

  const ctx = options.briefingContext;
  const requestedSectionNames = new Set(
    (options.requestedSections ?? [])
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .map(normalizeSectionFilterName),
  );
  const useLoadIndexLayout = renderMode === 'load' && ctx != null;

  const sections = children
    .filter(c =>
      c.parentId === project.id &&
      !c.tags.includes('#session-summary') &&
      c.metadata.kind !== 'commits-root' &&
      c.metadata.kind !== 'sessions-root',
    )
    .sort(compareEntryOrder);

  const headerLines: string[] = [
    FORMAT_SEP,
    `${label} — ${parsed.title}`,
    FORMAT_SEP,
    projectMetaLine(project, parsed, ctx?.lastActivityDate),
  ];
  const tags = project.tags.map(t => (t.startsWith('#') ? t : `#${t}`)).join(' ');
  if (tags) headerLines.push(`Tags: ${tags}`);
  headerLines.push(`Access: ${project.metadata.access_count ?? 0}`);
  const projectPreview = resolveProjectPreview(project, sections);
  if (projectPreview) headerLines.push('', projectPreview);
  const rulesSection = sections.find(isRulesSection);

  const sectionsIndexLines: string[] = [];
  if (sections.length > 0) {
    sectionsIndexLines.push('', `── Sections (${sections.length}) ──`, '');
    for (const section of sections) {
      const name = entryTitle(section);
      if (useLoadIndexLayout && isOverviewSection(section)
        && !sectionExplicitlyRequested(section, name, requestedSectionNames)) {
        if (overviewNeedsReadPointer(section, childMap)) {
          const subkids = childMap.get(section.id) ?? [];
          const hint = subkids.length > 0
            ? `${subkids.length} more`
            : 'full body';
          sectionsIndexLines.push(
            `  Overview (${hint}) — tim_read("${section.id}")`,
          );
        }
        continue;
      }
      if (useLoadIndexLayout && isTasksSection(section)
        && !sectionExplicitlyRequested(section, name, requestedSectionNames)) {
        const counts = ctx?.openTaskCounts ?? countOpenTasks(childMap.get(section.id) ?? []);
        sectionsIndexLines.push(
          `  Tasks (${counts.open} open, ${counts.stale} stale) — tim_read("${section.id}")`,
        );
        continue;
      }
      if (isBugsSection(section)) {
        const openCount = ctx?.openBugCount ?? countOpenBugs(childMap.get(section.id) ?? []);
        sectionsIndexLines.push(`  Bugs (${openCount} open) — tim_read("${section.id}")`);
        continue;
      }
      sectionsIndexLines.push(`  ${name} — tim_read("${section.id}")`);
    }
    // Count what is listed: the Overview renders in the header and is skipped here.
    sectionsIndexLines[1] = `── Sections (${sectionsIndexLines.length - 3}) ──`;
    if (sectionsIndexLines.length === 3) sectionsIndexLines.length = 0;
  }

  const blocks: BriefingBlock[] = [{
    id: 'header',
    priority: BRIEFING_PRIORITY.header,
    order: LOAD_BLOCK_ORDER.header,
    lines: headerLines,
  }];

  if (ctx?.nowBlockLines?.length) {
    blocks.push({
      id: 'now',
      priority: BRIEFING_PRIORITY.urgentTasks,
      order: LOAD_BLOCK_ORDER.now,
      lines: ctx.nowBlockLines,
    });
  }

  if (rulesSection) {
    const rulesBody = renderRulesBlock(rulesSection, childMap);
    if (rulesBody.length > 0) {
      blocks.push({
        id: 'rules',
        priority: BRIEFING_PRIORITY.activeRules,
        order: LOAD_BLOCK_ORDER.rules,
        lines: ['', '── Rules ──', '', ...rulesBody],
        drillDown: `tim_read("${rulesSection.id}")`,
      });
    }
  }

  if (projectSummary) {
    const summaryBody = options.tokenBudget != null
      ? clampSummaryHead(projectSummary, 2000)
      : projectSummary;
    blocks.push({
      id: 'project-summary',
      priority: BRIEFING_PRIORITY.header,
      order: LOAD_BLOCK_ORDER.projectSummary,
      lines: ['', '── Project Summary ──', '', summaryBody],
    });
  }

  if (sectionsIndexLines.length > 0) {
    blocks.push({
      id: 'sections-index',
      priority: BRIEFING_PRIORITY.header,
      order: LOAD_BLOCK_ORDER.sectionsIndex,
      lines: sectionsIndexLines,
    });
  }

  if (sections.length > 0) {
    for (const section of sections) {
      const name = entryTitle(section);
      const explicit = sectionExplicitlyRequested(section, name, requestedSectionNames);
      if (useLoadIndexLayout && !explicit) {
        if (isOverviewSection(section) || isTasksSection(section) || isRulesSection(section)) {
          continue;
        }
      }
      const rendered = renderSectionBody(
        section, name, childMap, budgetState, schema, renderMode, seenBodies, true,
      );
      if (!rendered || rendered.bodyLines.length === 0) continue;
      if (isNoEntriesOnlyBody(rendered.bodyLines)) continue;
      blocks.push({
        id: `section:${section.id}`,
        priority: sectionPriority(name, false),
        order: LOAD_BLOCK_ORDER.sectionBodyBase + rendered.order,
        lines: ['', rendered.header, ...rendered.bodyLines],
      });
    }
  }

  if (ctx?.recentSessions && ctx.recentSessions.length > 0) {
    const total = ctx.totalSessionCount ?? ctx.recentSessions.length;
    const sessionLines: string[] = [
      '',
      `── Recent Sessions (${ctx.recentSessions.length}/${total}) ──`,
      '',
    ];
    for (const session of ctx.recentSessions) {
      sessionLines.push(`  ${session.exchanges} exchanges · ${session.date}`);
      for (const line of session.summary) sessionLines.push(`    ${line}`);
      if (session.summary.length === 0) sessionLines.push('    (no summary yet)');
    }
    if (ctx.hiddenShortSessionCount && ctx.hiddenShortSessionCount > 0) {
      sessionLines.push(
        `  + ${ctx.hiddenShortSessionCount} sessions hidden (short or no substance)`,
      );
    }
    if (total > ctx.recentSessions.length) {
      const hidden = total - ctx.recentSessions.length;
      sessionLines.push(
        `  … ${hidden} older sessions — tim_resume_list({projectId:"${label}"})`,
      );
    }
    blocks.push({
      id: 'recent-sessions',
      priority: BRIEFING_PRIORITY.recentSession,
      order: LOAD_BLOCK_ORDER.recentSessions,
      lines: sessionLines,
      drillDown: `tim_resume_list({projectId:"${label}"})`,
    });
  } else {
    const sessions = children
      .filter(c => c.tags.includes('#session-summary'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (sessions.length > 0) {
      const shown = recentSessionsCount > 0 ? recentSessionsCount : RECENT_SESSIONS_COUNT;
      const recent = sessions.slice(0, shown);
      const sessionLines: string[] = [
        '',
        `── Recent Sessions (${recent.length}/${sessions.length}) ──`,
        '',
      ];
      for (const session of recent) {
        const { exchanges, summary, date } = parseSessionEntry(
          session,
          entryById.get(session.parentId ?? ''),
        );
        sessionLines.push(`  ${exchanges} exchanges · ${date}`);
        for (const line of summary) sessionLines.push(`    ${line}`);
        if (summary.length === 0) sessionLines.push('    (no summary yet)');
      }
      if (sessions.length > shown) {
        const hidden = sessions.length - shown;
        sessionLines.push(
          `  … ${hidden} older sessions — tim_resume_list({projectId:"${label}"})`,
        );
      }
      blocks.push({
        id: 'recent-sessions',
        priority: BRIEFING_PRIORITY.recentSession,
        order: LOAD_BLOCK_ORDER.recentSessions,
        lines: sessionLines,
        drillDown: `tim_resume_list({projectId:"${label}"})`,
      });
    }
  }

  if (options.query && options.queryExtras && options.queryExtras.length > 0) {
    const extras = formatQueryExtrasBlock(options.queryExtras, options.query);
    if (extras) blocks.push(extras);
  }

  const footerLines = [
    '',
    FORMAT_SEP,
    `children: ${children.length} · truncated: ${truncated}`,
    `Use tim_read("${label}") to drill into any section.`,
    FORMAT_SEP,
  ];
  blocks.push({
    id: 'footer',
    priority: BRIEFING_PRIORITY.general,
    order: LOAD_BLOCK_ORDER.footer,
    lines: footerLines,
  });

  const { text } = assembleBoundedBriefingText(
    blocks,
    options.tokenBudget ?? 0,
    options.trailingSuffix ? [options.trailingSuffix] : [],
    `tim_load_project({label:"${label}", bind:false})`,
  );
  return text;
}

export function formatProjectOutput(
  result: LoadProjectResult,
  budget: number,
  schema?: ProjectSchema,
  renderMode?: 'load' | 'read',
  recentSessionsCount: number = RECENT_SESSIONS_COUNT,
  options?: FormatProjectOutputOptions,
): string {
  if (options?.tokenBudget != null) {
    return formatProjectOutputWithTokenBudget(
      result,
      budget,
      schema,
      renderMode,
      recentSessionsCount,
      options,
    );
  }
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
  const entryById = new Map(children.map(c => [c.id, c]));
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
      const prepared = prepareSectionChildren(rawSubkids, name, section.id);
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
              section.id,
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
      const { exchanges, summary, date } = parseSessionEntry(session, entryById.get(session.parentId ?? ''));
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

  if (options?.trailingSuffix) {
    lines.push(options.trailingSuffix);
  }

  return lines.join('\n');
}
