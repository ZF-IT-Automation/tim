import type { Entry } from 'tim-core';
import type { LoadProjectResult } from 'tim-store';
import { isTaskMarker } from 'tim-store';
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
  return t.slice(0, max) + '…';
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

function parseSessionEntry(entry: Entry): { exchanges: number; summary: string; date: string } {
  const date = entry.createdAt.slice(0, 10);
  const combined = entry.content ? `${entry.title}\n${entry.content}` : entry.title;
  const exMatch = combined.match(/(\d+)\s+exchanges?/i);
  const exchanges = exMatch ? parseInt(exMatch[1], 10) : 0;
  let summary = combined;
  if (exMatch) {
    summary = combined.replace(/\s*[—–-]\s*\d+\s+exchanges?.*$/i, '').trim();
  }
  return { exchanges, summary: truncText(summary, 120), date };
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

function entryBadge(entry: Entry): string {
  if (isTaskMarker(entry.metadata.task)) {
    const status = resolveEntryTaskStatus(entry.metadata);
    return ` [${status}]`;
  }
  if (entry.metadata.kind === 'error') {
    return ` [${entry.metadata.severity || 'medium'}]`;
  }
  return '';
}

interface FormatBudget {
  remaining: number;
}

const MAX_CHILDREN_PER_LEVEL = 10;
const PROJECT_SUMMARY_MARKER = '## Project Summary';
const RECENT_SESSIONS_COUNT = 5; // TODO: read from config

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
): string[] {
  if (children.length === 0 || budget.remaining <= 0) return [];

  const lines: string[] = [];
  const indent = ' '.repeat(4 + depth * 2);
  const maxShow = Math.min(MAX_CHILDREN_PER_LEVEL, children.length);
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
    for (const section of sections) {
      const name = entryTitle(section);
      const schemaSection = findSchemaSection(schema?.sections, name);
      const renderDepth = resolveRenderDepth(section, schemaSection?.render_depth, renderMode);

      // renderDepth=0 → skip entire section node + subtree
      if (renderDepth === 0) {
        continue;
      }

      const useTail = resolveRenderTail(section, schemaSection?.render_tail);
      const subkids = childMap.get(section.id) ?? [];
      lines.push(`  ${name}`);
      if (subkids.length > 0 && !shouldRenderChildren(renderDepth)) {
        lines.push(`    ${childCountLabel(subkids.length)}`);
      } else {
        const content = sectionContentBody(section);
        if (content) {
          lines.push(`    ${content}`);
        } else if (subkids.length === 0) {
          lines.push(`    No entries`);
        }
        if (subkids.length > 0 && shouldRenderChildren(renderDepth)) {
          const nextDepth = maxChildDepth(renderDepth);
          if (nextDepth > 0) {
            lines.push(...formatChildrenTree(subkids, childMap, 0, budgetState, schema, useTail, renderMode));
          }
        }
      }
    }
  }

  if (sessions.length > 0) {
    const recent = sessions.slice(0, RECENT_SESSIONS_COUNT);
    lines.push('', `── Recent Sessions (${recent.length}/${sessions.length}) ──`, '');
    for (const session of recent) {
      const { exchanges, summary, date } = parseSessionEntry(session);
      lines.push(`  ${exchanges} exchanges · ${date}  "${summary}"`);
    }
    if (sessions.length > RECENT_SESSIONS_COUNT) {
      lines.push(`  … ${sessions.length - RECENT_SESSIONS_COUNT} older sessions`);
    }
  }

  lines.push('', FORMAT_SEP);
  lines.push(`children: ${children.length} · truncated: ${truncated}`);
  lines.push(`Use tim_read("${label}") to drill into any section.`);
  lines.push(FORMAT_SEP);

  return lines.join('\n');
}
