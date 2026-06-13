// TIM MCP Server — v0.1.0-alpha
// MCP stdio server with curation, session, and core memory tools.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  TimStore,
  SessionManager,
  CommitManager,
  formatProjectOutput,
  ensureInboxProject,
  INBOX_PROJECT_LABEL,
  ErrorLogger,
  type TaskRecord,
  type ProjectSchema,
} from 'tim-store';
import { loadConfig, resolveActiveSessionId, evaluateLoadGate, type EdgeType, type Entry } from 'tim-core';
import {
  findMarker,
  getActiveProjectLabel,
  maybeSpawnSummarizer,
  syncNearestProjectMarker,
} from 'tim-hooks';
import { tim_export, tim_import } from 'tim-migrate';
import { autoPush, autoPull, resetSyncCooldowns, loadConfig as loadSyncConfig } from 'tim-sync-client';
import { validateWriteTags } from './write-validate.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Tool Schemas ───────────────────────────────────────

const TimReadSchema = z.object({
  id: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Entry ID (ULID), or array of IDs for batch read'),
  project: z.string().optional().describe('Project label/alias/name (auto-resolved)'),
  section: z.string().optional().describe('Section title — read its children'),
  depth: z.number().min(1).max(5).optional().default(2),
  includeEdges: z.boolean().optional().default(false),
  includeChildren: z.boolean().optional().default(true).describe('Default true: returns subtree (capped by depth). Set false for parent-only.'),
  showIrrelevant: z.boolean().optional().default(false),
}).refine(
  d => d.id !== undefined || d.project !== undefined || d.section !== undefined,
  { message: 'tim_read requires one of: id, project, section' },
);

const TimWriteSchema = z.object({
  content: z.string().describe('Entry body content'),
  title: z.string().optional(),
  parentId: z.string().optional(),
  parentTitle: z.string().optional().describe('Resolve parent by title within a project'),
  projectId: z.string().optional().describe('Project label for parentTitle resolution, e.g. P0062'),
  where: z.string().optional()
    .describe('Shorthand "P0062/Tasks" → resolves project + section to parentId. ' +
              'Loses to explicit parentId. Project part accepts label/alias/name.'),
  contentType: z.enum(['text', 'json', 'blob']).optional().default('text'),
  confidence: z.number().min(0).max(1).optional().default(1.0),
  tags: z.array(z.string()).optional().default([]),
  visibility: z.number().optional().default(1),
  metadata: z.record(z.unknown()).optional().default({}),
});

const TimSearchSchema = z.object({
  query: z.string().describe('FTS5 search query'),
  topK: z.number().min(1).max(100).optional().default(10),
  searchType: z.enum(['fts', 'vector', 'hybrid']).optional().default('fts'),
  root: z.string().optional().describe('Scope to project (label/alias/name)'),
  type: z.string().optional().describe('Filter metadata.type (rule|human|task|error)'),
  tag: z.string().optional().describe('Filter exact tag (with or without # prefix)'),
  status: z.string().optional().describe('Filter metadata.status'),
});

const TimLinkSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  type: z.enum([
    'relates', 'extends', 'contradicts', 'implements',
    'blocks', 'leases', 'tagged', 'summarizes', 'contradicted_by'
  ]),
  weight: z.number().min(0).max(1).optional().default(1.0),
  metadata: z.record(z.unknown()).optional().default({}),
});

const TimTraceSchema = z.object({
  startId: z.string(),
  edgeType: z.string().optional(),
  depth: z.number().min(1).max(20).optional().default(5),
});

const TimUpdateSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const TimDeleteSchema = z.object({
  id: z.string(),
  hard: z.boolean().optional().default(false),
});

const TimSyncSchema = z.object({
  action: z.enum(['push', 'pull', 'status']),
  stagingRecords: z.array(z.object({
    key: z.string(),
    entityType: z.enum(['entry', 'edge']),
    operation: z.enum(['upsert', 'delete']),
    payload: z.string(),
    lwwTimestamp: z.number(),
    lwwDevice: z.string(),
    lwwConfidence: z.number().optional().default(1.0),
    acked: z.boolean().optional().default(false),
  })).optional(),
});

const TimLeaseSchema = z.object({
  grant: z.string().optional().describe('Agent label to grant access to'),
  revoke: z.string().optional().describe('Agent label to revoke access from'),
  entryId: z.string(),
  ttl: z.string().optional().describe('Duration: 1h, 30m, 7d'),
});

const TimSuppressSchema = z.object({
  pattern: z.string(),
  reason: z.string().optional().default('Manual suppression'),
  ttl: z.string().optional(),
});

const TimExportSchema = z.object({
  format: z.enum(['text', 'hmem', 'md']).optional().default('text'),
  targetPath: z.string().optional().describe('Output path for hmem export'),
});

const TimImportSchema = z.object({
  source: z.string().describe('Path to .hmem file'),
  dryRun: z.boolean().optional().default(false),
  deduplicate: z.boolean().optional().default(false),
});

const TimDoctorSchema = z.object({});

const TimSessionStartSchema = z.object({
  sessionId: z.string(),
  projectId: z.string().optional().describe('Project label, e.g. P0062 — enables nested session tree'),
  agentName: z.string().optional().default('default'),
  cwd: z.string().optional(),
  harness: z.string().optional().default('mcp'),
  batchSize: z.number().min(1).max(50).optional(),
  tool: z.string().optional().describe('CLI tool used, e.g. claude, cursor, codex'),
  model: z.string().optional().describe('Model name, e.g. opus, composer-2.5'),
  taskSummary: z.string().optional().describe('One-line description of what was delegated'),
});

const TimShowUnsummarizedSchema = z.object({
  sessionId: z.string(),
});

const TimWriteBatchSummarySchema = z.object({
  sessionId: z.string(),
  batchIndex: z.number().int().positive(),
  summary: z.string(),
  seqFrom: z.number().int().nonnegative(),
  seqTo: z.number().int().nonnegative(),
  tags: z.array(z.string()).optional(),
});

const TimRecordCommitSchema = z.object({
  projectId: z.string().describe('Project label, e.g. P0063'),
  hash: z.string().describe('Full git commit SHA'),
  message: z.string().describe('Commit message body'),
  diffSummary: z.string().optional().describe('git show --stat output'),
  sessionId: z.string().optional().describe('Session that produced this commit'),
  branch: z.string().optional(),
  author: z.string().optional(),
  date: z.string().optional().describe('ISO 8601 commit date'),
});

const TimSessionLogSchema = z.object({
  sessionId: z.string(),
  entries: z.array(z.object({
    role: z.enum(['user', 'agent']),
    content: z.string(),
  })),
});

const TimCheckpointSchema = z.object({
  sessionId: z.string(),
});

const TimRenameEntrySchema = z.object({
  oldId: z.string(),
  newId: z.string(),
});

const TimMoveEntrySchema = z.object({
  id: z.string(),
  newParentId: z.string().nullable().optional().default(null),
  order: z.number().optional(),
});

const TimUpdateManySchema = z.object({
  ids: z.array(z.string()).min(1),
  irrelevant: z.boolean().optional(),
  favorite: z.boolean().optional(),
});

const TimTagAddSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()).min(1),
});

const TimTagRemoveSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()).min(1),
});

const TimTagRenameSchema = z.object({
  oldTag: z.string(),
  newTag: z.string(),
});

const TimCreateProjectSchema = z.object({
  label: z.string().describe('Project label, e.g. P0062'),
  metadata: z.record(z.unknown()).optional().default({}),
  content: z.string().optional(),
  aliases: z.array(z.string()).optional().describe('Short names for tim_load_project, e.g. ["o9k", "hmem"]'),
});

const TimLoadProjectSchema = z.object({
  label: z.string().describe('Project label, e.g. P0062'),
  depth: z.number().min(1).max(5).optional().default(3),
  budget: z.number().min(1).max(1000).optional().default(200),
  sections: z.array(z.string()).nullable().optional().default(null),
  sessionId: z.string().optional().describe('Harness session id; binds TIM session project_ref on first load only'),
});

const TimReadProjectSchema = z.object({
  label: z.string().describe('Project label, e.g. P0062'),
  depth: z.number().min(1).max(5).optional().default(3),
  budget: z.number().min(1).max(1000).optional().default(200),
  sections: z.array(z.string()).nullable().optional().default(null),
});

const TimTasksSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional(),
});

const TimShowSchema = z.object({
  what: z.string().describe(
    'tasks|errors|bugs|ideas|decisions|learnings|commits|all|<SectionName>',
  ),
  root: z.string().optional().describe(
    'project label/alias/name; "" or "all" = ALL projects; omit = active project',
  ),
  with: z.string().optional().describe(
    'comma-separated AND filters: open,done,urgent,recent,<tagname>,<free text>',
  ),
  limit: z.number().min(1).max(100).optional().default(20),
});

const TimErrorStatsSchema = z.object({
  hours: z.number().min(1).max(720).optional().default(24),
  limit: z.number().min(1).max(100).optional().default(10),
});

const TimErrorLogSchema = z.object({
  tool: z.string(),
  error: z.string(),
  stack: z.string().optional(),
  sessionId: z.string().optional(),
  args: z.record(z.unknown()).optional(),
});

// ─── Project output formatting ──────────────────────────

function loadProjectSchema(): ProjectSchema | undefined {
  const schemaPath = path.join(process.cwd(), 'docs/project-schema.json');
  try {
    if (fs.existsSync(schemaPath)) {
      return JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as ProjectSchema;
    }
  } catch {
    // schema optional
  }
  return undefined;
}

function truncText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 3) + '...';
}

function parseProjectContent(entry: Entry): { title: string; status: string; description: string; packages?: number; tests?: number } {
  const combined = entry.content ? `${entry.title}\n${entry.content}` : entry.title;
  const parts = combined.split('|').map(p => p.trim());
  const title = parts[0] || entry.title || combined;
  const status = parts[1] || 'Unknown';
  const rest = parts.length > 3 ? parts.slice(3).join(' | ') : parts.slice(1).join(' | ');
  const packagesMatch = combined.match(/(\d+)[-\s]Package/i);
  const testsMatch =
    combined.match(/\((\d+)\s+tests?\)/i) ?? combined.match(/\b(\d+)\s+tests?\b/i);
  return {
    title,
    status,
    description: truncText(rest || combined, 150),
    packages: packagesMatch ? parseInt(packagesMatch[1], 10) : undefined,
    tests: testsMatch ? parseInt(testsMatch[1], 10) : undefined,
  };
}

const TASK_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  todo: 1,
};
const TASK_PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function sortTaskRecords(tasks: TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => {
    const statusA = TASK_STATUS_ORDER[a.status ?? ''] ?? 2;
    const statusB = TASK_STATUS_ORDER[b.status ?? ''] ?? 2;
    if (statusA !== statusB) return statusA - statusB;

    const priorityA = TASK_PRIORITY_ORDER[a.priority ?? ''] ?? 3;
    const priorityB = TASK_PRIORITY_ORDER[b.priority ?? ''] ?? 3;
    if (priorityA !== priorityB) return priorityA - priorityB;

    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due.localeCompare(b.due);
  });
}

function taskStatusIcon(status: string | null): string {
  switch (status) {
    case 'in_progress': return '[!]';
    case 'done': return '[x]';
    case 'cancelled': return '[-]';
    default: return '[ ]';
  }
}

function taskPriorityLabel(priority: string | null): string {
  switch (priority) {
    case 'high': return 'HIGH';
    case 'medium': return 'MED';
    case 'low': return 'LOW';
    default: return '';
  }
}

function isTaskOverdue(due: string | null, status: string | null): boolean {
  if (!due || status === 'done' || status === 'cancelled') return false;
  const today = new Date().toISOString().slice(0, 10);
  return due < today;
}

function formatTaskLine(task: TaskRecord): string {
  const icon = taskStatusIcon(task.status);
  const priority = taskPriorityLabel(task.priority);
  const priorityPart = priority ? `[${priority}]` : '';
  const duePart = task.due ? `[due: ${task.due}]` : '';
  const overdue = isTaskOverdue(task.due, task.status) ? '[OVERDUE] ' : '';
  const statusSuffix = task.status ? ` (${task.status})` : '';
  const meta = [icon, priorityPart, duePart].filter(Boolean).join(' ');
  return `  ${overdue}${meta} ${task.title}${statusSuffix}`;
}

async function formatTasksOutput(store: TimStore, tasks: TaskRecord[]): Promise<string> {
  const grouped = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const key = task.project_label ?? '(no project)';
    const list = grouped.get(key) ?? [];
    list.push(task);
    grouped.set(key, list);
  }

  const projectLabels = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const projectCount = projectLabels.filter(l => l !== '(no project)').length;
  const lines: string[] = [
    `=== TASKS (${tasks.length} open across ${projectCount} projects) ===`,
    '',
  ];

  for (const label of projectLabels) {
    const groupTasks = sortTaskRecords(grouped.get(label)!);
    let header = label;
    if (label !== '(no project)') {
      const project = await store.read(label);
      if (project) {
        const parsed = parseProjectContent(project);
        header = `${label} — ${parsed.title}`;
      }
    }
    lines.push(header);
    for (const task of groupTasks) {
      lines.push(formatTaskLine(task));
    }
    lines.push('');
  }

  lines.push('Status legend: [!] = in_progress, [ ] = todo, [x] = done, [-] = cancelled');
  return lines.join('\n').trimEnd();
}

type ResolveRootsResult =
  | { labels: string[]; error?: undefined }
  | { labels?: undefined; error: string };

async function resolveRoots(store: TimStore, root?: string): Promise<ResolveRootsResult> {
  if (root === undefined) {
    const marker = findMarker(process.cwd());
    if (marker) return { labels: [marker.marker.project] };
    const active = getActiveProjectLabel();
    if (active) return { labels: [active] };
    return { error: 'no active project; pass root explicitly or "all"' };
  }

  if (root === '' || root.toLowerCase() === 'all') {
    const projects = await store.listProjects();
    return { labels: projects.map(p => p.label) };
  }

  const r = await store.resolveProjectLabel(root);
  if (r.status === 'found') return { labels: [r.label] };
  if (r.status === 'ambiguous') {
    return { error: `ambiguous: ${r.labels.join(', ')}` };
  }

  const needle = root.toLowerCase();
  const hits = (await store.listProjects()).filter(p =>
    p.title.toLowerCase().includes(needle),
  );
  if (hits.length === 1) return { labels: [hits[0]!.label] };
  if (hits.length > 1) {
    return { error: `ambiguous name: ${hits.map(h => h.label).join(', ')}` };
  }
  return { error: `root not found: ${root}` };
}

function dedupeById(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function scopeEntries(store: TimStore, entries: Entry[], labels: string[]): Entry[] {
  return entries.filter(e => {
    const label = store.getProjectLabel(e.id);
    return label != null && labels.includes(label);
  });
}

async function sectionChildren(
  store: TimStore,
  name: string,
  labels: string[],
): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const label of labels) {
    const resolved = await store.resolveProjectLabel(label);
    if (resolved.status !== 'found') continue;
    const project = await store.read(resolved.label);
    if (!project) continue;
    const sec = await store.resolveSectionByTitle(project.id, name);
    if (sec.status === 'found') {
      result.push(...await store.getChildren(sec.id));
    } else if (sec.status === 'ambiguous') {
      for (const cand of sec.candidates) {
        result.push(...await store.getChildren(cand.id));
      }
    }
  }
  return result;
}

async function allSectionChildren(store: TimStore, labels: string[]): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const label of labels) {
    const resolved = await store.resolveProjectLabel(label);
    if (resolved.status !== 'found') continue;
    const project = await store.read(resolved.label);
    if (!project) continue;
    const sections = await store.getChildren(project.id);
    for (const section of sections) {
      result.push(...await store.getChildren(section.id));
    }
  }
  return result;
}

async function fetchByWhat(
  store: TimStore,
  what: string,
  labels: string[],
): Promise<Entry[]> {
  const lc = what.toLowerCase();
  switch (lc) {
    case 'tasks': {
      const rows = await store.getTasks();
      const scoped = rows.filter(r =>
        r.project_label != null && labels.includes(r.project_label),
      );
      const entries: Entry[] = [];
      for (const row of scoped) {
        const e = await store.read(row.id);
        if (e) entries.push(e);
      }
      return entries;
    }
    case 'errors': {
      const a = await store.getByMetadataType('error');
      const b = await store.getByTag('#error');
      return scopeEntries(store, dedupeById([...a, ...b]), labels);
    }
    case 'bugs':
      return scopeEntries(store, await store.getByTag('#bug'), labels);
    case 'decisions':
      return scopeEntries(store, await store.getByTag('#decision'), labels);
    case 'learnings':
      return scopeEntries(store, await store.getByTag('#learning'), labels);
    case 'commits':
      return scopeEntries(store, await store.getByMetadataKind('commit', 1000), labels);
    case 'ideas':
      return sectionChildren(store, 'Ideas', labels);
    case 'all':
      return allSectionChildren(store, labels);
    default:
      return sectionChildren(store, what, labels);
  }
}

const SHOW_STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  todo: 1,
};
const SHOW_PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

async function applyWith(
  store: TimStore,
  entries: Entry[],
  withStr: string | undefined,
): Promise<Entry[]> {
  if (!withStr) return entries;
  const terms = withStr.split(',').map(t => t.trim()).filter(Boolean);
  let result = entries;
  const ftsTerms: string[] = [];

  for (const t of terms) {
    const lc = t.toLowerCase();
    switch (lc) {
      case 'open':
        result = result.filter(e => {
          const st = e.metadata.status as string | undefined;
          return st !== 'done' && st !== 'cancelled';
        });
        break;
      case 'done':
        result = result.filter(e => e.metadata.status === 'done');
        break;
      case 'urgent':
        result = result.filter(e => e.tags.includes('#urgent'));
        break;
      case 'recent': {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        result = result.filter(e => Date.parse(e.createdAt) >= cutoff);
        break;
      }
      default: {
        const tagForm = t.startsWith('#') ? t : `#${t}`;
        if (result.some(e => e.tags.includes(tagForm) || e.tags.includes(t))) {
          result = result.filter(e => e.tags.includes(tagForm) || e.tags.includes(t));
        } else {
          ftsTerms.push(t);
        }
        break;
      }
    }
  }

  if (ftsTerms.length > 0) {
    const hitIds = new Set<string>();
    for (const q of ftsTerms) {
      const hits = await store.searchFts(q, 1000);
      for (const e of hits) hitIds.add(e.id);
    }
    result = result.filter(e => hitIds.has(e.id));
  }

  return result;
}

function sortForShow(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    const statusA = SHOW_STATUS_ORDER[String(a.metadata.status ?? '')] ?? 2;
    const statusB = SHOW_STATUS_ORDER[String(b.metadata.status ?? '')] ?? 2;
    if (statusA !== statusB) return statusA - statusB;

    const priorityA = SHOW_PRIORITY_ORDER[String(a.metadata.priority ?? '')] ?? 3;
    const priorityB = SHOW_PRIORITY_ORDER[String(b.metadata.priority ?? '')] ?? 3;
    if (priorityA !== priorityB) return priorityA - priorityB;

    return b.createdAt.localeCompare(a.createdAt);
  });
}

function formatShowLine(entry: Entry): string {
  const icon = taskStatusIcon((entry.metadata.status as string | null) ?? null);
  const title = entry.title.padEnd(44, ' ');
  const tagStr = entry.tags.join(' ');
  return `  ${icon} ${title}${tagStr ? ' ' + tagStr : ''}`.trimEnd();
}

async function formatShowOutput(store: TimStore, entries: Entry[]): Promise<string> {
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    const label = store.getProjectLabel(entry.id) ?? '(no project)';
    const list = grouped.get(label) ?? [];
    list.push(entry);
    grouped.set(label, list);
  }

  const projectLabels = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const lines: string[] = [];

  for (const label of projectLabels) {
    const groupEntries = sortForShow(grouped.get(label)!);
    let header = label;
    if (label !== '(no project)') {
      const project = await store.read(label);
      if (project) {
        const parsed = parseProjectContent(project);
        header = `${label} — ${parsed.title}`;
      }
    }
    lines.push(header);
    for (const entry of groupEntries) {
      lines.push(formatShowLine(entry));
    }
    lines.push('');
  }

  lines.push('[!]=in_progress [ ]=todo [x]=done [-]=cancelled');
  return lines.join('\n').trimEnd();
}

function resolveProjectRef(session: Entry): string | null {
  const uid = session.metadata.project_uid ?? session.metadata.projectUid;
  if (typeof uid === 'string' && uid) return uid;
  const label = session.metadata.projectLabel ?? session.metadata.project_label;
  if (typeof label === 'string' && label) return label;
  return getActiveProjectLabel();
}

async function buildCortexReadyBlock(store: TimStore, session: Entry): Promise<string | null> {
  const ref = resolveProjectRef(session);
  if (!ref) return null;

  const projectEntry = await store.read(ref);
  if (!projectEntry || projectEntry.metadata.kind !== 'project') return null;

  const label = String(projectEntry.metadata.label ?? ref);
  const parsed = parseProjectContent(projectEntry);
  const stats = await store.stats();

  const loadResult = await store.loadProject(label, { depth: 3, budget: 150 });
  const sessionSummaries = (loadResult?.children ?? []).filter(c =>
    c.tags.includes('#session-summary'),
  );

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekIso = weekAgo.toISOString();
  const sessionsThisWeek = sessionSummaries.filter(s => s.createdAt >= weekIso).length;

  const lastDate =
    sessionSummaries[0]?.createdAt.slice(0, 10) ?? projectEntry.createdAt.slice(0, 10);

  const shortName = parsed.title.split('—')[0]?.trim() || parsed.title;
  const entriesStr = stats.totalEntries.toLocaleString('en-US');
  const metaBits: string[] = [parsed.status];
  if (parsed.tests != null) metaBits.push(`${parsed.tests} tests`);
  metaBits.push(`${entriesStr} entries`);

  return [
    '[CORTEX READY]',
    `Project: ${shortName} (${label}) — ${metaBits.join(' · ')}`,
    `Last: ${lastDate} · ${sessionsThisWeek} sessions this week`,
    '[/CORTEX READY]',
  ].join('\n');
}

// ─── MCP Server Setup ───────────────────────────────────

const DB_PATH = process.env.TIM_DB_PATH || loadConfig().dbPath || process.env.HOME + '/.tim/tim.db';

let store: TimStore;
let sessions: SessionManager;
let commitMgr: CommitManager;
let errorLogger: ErrorLogger;

function getStore(): TimStore {
  if (!store) {
    store = new TimStore(DB_PATH);
  }
  return store;
}

function getErrorLogger(): ErrorLogger {
  if (!errorLogger) {
    errorLogger = new ErrorLogger(getStore().getDb());
  }
  return errorLogger;
}

function getCommitManager(): CommitManager {
  if (!commitMgr) {
    commitMgr = new CommitManager(getStore());
  }
  return commitMgr;
}

function getSessions(): SessionManager {
  if (!sessions) {
    const mgr = new SessionManager(getStore());
    mgr.setOnBatchFull(({ sessionId }) => {
      void (async () => {
        const session = await getStore().read(sessionId);
        const cwd = typeof session?.metadata.cwd === 'string' ? session.metadata.cwd : undefined;
        if (!cwd) return;
        await maybeSpawnSummarizer(getStore(), cwd, { batchFull: true });
      })();
    });
    sessions = mgr;
  }
  return sessions;
}

const WRITE_TOOLS = new Set([
  'tim_write', 'tim_update', 'tim_delete', 'tim_link',
  'tim_session_start', 'tim_session_log', 'tim_checkpoint', 'tim_write_batch_summary',
  'tim_record_commit',
  'tim_rename_entry', 'tim_move_entry', 'tim_update_many',
  'tim_tag_add', 'tim_tag_remove', 'tim_tag_rename', 'tim_import',
  'tim_create_project', 'tim_error_log',
]);

const READ_TOOLS = new Set([
  'tim_read', 'tim_search', 'tim_trace', 'tim_health', 'tim_stats',
  'tim_export', 'tim_doctor', 'tim_sync', 'tim_load_project', 'tim_read_project', 'tim_tasks',
  'tim_show',
  'tim_show_unsummarized', 'tim_show_all_unsummarized', 'tim_show_untagged',
]);

function scheduleAutoSync(toolName: string, s: TimStore): void {
  if (WRITE_TOOLS.has(toolName)) {
    void autoPush(s);
  } else if (READ_TOOLS.has(toolName)) {
    void autoPull(s);
  }
}

export async function startServer(): Promise<void> {
  const server = new Server(
    {
      name: 'tim-mcp',
      version: '0.1.0-alpha',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ─── Tool Registration ──────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'tim_read',
        description: 'Read an entry from TIM. Returns entry content, children, and optional edges.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              oneOf: [
                { type: 'string', description: 'Entry ID (ULID)' },
                { type: 'array', items: { type: 'string' }, description: 'Batch entry IDs' },
              ],
            },
            project: { type: 'string', description: 'Project label/alias/name (auto-resolved)' },
            section: { type: 'string', description: 'Section title — read its children' },
            depth: { type: 'number', default: 2, description: 'How many levels to read (1-5)' },
            includeEdges: { type: 'boolean', default: false },
            includeChildren: { type: 'boolean', default: true, description: 'Default true: returns subtree (capped by depth). Set false for parent-only.' },
            showIrrelevant: { type: 'boolean', default: false },
          },
        },
      },
      {
        name: 'tim_write',
        description: 'Write a new entry to TIM. parentId direct, or parentTitle+projectId to resolve a project section by title (section title under project root metadata.label).',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            parentId: { type: 'string' },
            parentTitle: { type: 'string', description: 'Section title; requires projectId' },
            projectId: { type: 'string', description: 'Project label, e.g. P0062' },
            where: {
              type: 'string',
              description: 'Shorthand P0062/Tasks → project + section parentId (parentId wins)',
            },
            contentType: { type: 'string', enum: ['text', 'json', 'blob'], default: 'text' },
            confidence: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
            tags: { type: 'array', items: { type: 'string' }, default: [] },
            visibility: { type: 'number', default: 1 },
            metadata: { type: 'object', default: {} },
          },
          required: ['content'],
        },
      },
      {
        name: 'tim_search',
        description: 'Search TIM entries using FTS5 full-text search.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            topK: { type: 'number', default: 10 },
            searchType: { type: 'string', enum: ['fts', 'vector', 'hybrid'], default: 'fts' },
            root: { type: 'string', description: 'Scope to project (label/alias/name)' },
            type: { type: 'string', description: 'Filter metadata.type' },
            tag: { type: 'string', description: 'Filter exact tag' },
            status: { type: 'string', description: 'Filter metadata.status' },
          },
          required: ['query'],
        },
      },
      {
        name: 'tim_link',
        description: 'Create an edge (relationship) between two entries.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: { type: 'string' },
            targetId: { type: 'string' },
            type: { type: 'string', enum: ['relates', 'extends', 'contradicts', 'implements', 'blocks', 'leases', 'tagged', 'summarizes', 'contradicted_by'] },
            weight: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
            metadata: { type: 'object', default: {} },
          },
          required: ['sourceId', 'targetId', 'type'],
        },
      },
      {
        name: 'tim_trace',
        description: 'Follow an edge chain from a starting entry (BFS traversal).',
        inputSchema: {
          type: 'object',
          properties: {
            startId: { type: 'string' },
            edgeType: { type: 'string' },
            depth: { type: 'number', default: 5 },
          },
          required: ['startId'],
        },
      },
      {
        name: 'tim_update',
        description: 'Update an existing entry. Only provided fields are changed.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            tags: { type: 'array', items: { type: 'string' } },
            visibility: { type: 'number' },
            metadata: { type: 'object' },
          },
          required: ['id'],
        },
      },
      {
        name: 'tim_delete',
        description: 'Delete an entry (soft: mark irrelevant, hard: tombstone).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            hard: { type: 'boolean', default: false },
          },
          required: ['id'],
        },
      },
      {
        name: 'tim_sync',
        description: 'Sync operations: push staging records, pull from remote, or check status.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['push', 'pull', 'status'] },
            stagingRecords: { type: 'array' },
          },
          required: ['action'],
        },
      },
      {
        name: 'tim_lease',
        description: 'Grant or revoke temporary agent access to a memory entry.',
        inputSchema: {
          type: 'object',
          properties: {
            grant: { type: 'string' },
            revoke: { type: 'string' },
            entryId: { type: 'string' },
            ttl: { type: 'string' },
          },
          required: ['entryId'],
        },
      },
      {
        name: 'tim_suppress',
        description: 'Add a pattern to negative memory. Matching entries are hidden from search results.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            reason: { type: 'string', default: 'Manual suppression' },
            ttl: { type: 'string' },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'tim_health',
        description: 'Run health diagnostics: broken links, orphans, FTS integrity, counts.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tim_stats',
        description: 'Get memory statistics: totals, depth distribution, top tags, confidence.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tim_export',
        description: 'Export TIM database to markdown or .hmem SQLite format.',
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['text', 'hmem', 'md'], default: 'text' },
            targetPath: { type: 'string', description: 'Output path (required for hmem format)' },
          },
        },
      },
      {
        name: 'tim_import',
        description: 'Import entries from a .hmem SQLite file.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            dryRun: { type: 'boolean', default: false },
            deduplicate: { type: 'boolean', default: false },
          },
          required: ['source'],
        },
      },
      {
        name: 'tim_doctor',
        description: 'Run comprehensive diagnostics: config, DB, API connectivity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tim_session_start',
        description: 'Start a TIM session (idempotent). With projectId (or default P0000 Inbox), creates nested Sessions/Summary/Exchanges tree.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            projectId: { type: 'string', description: 'Project label, e.g. P0062' },
            agentName: { type: 'string', default: 'default' },
            cwd: { type: 'string' },
            harness: { type: 'string', default: 'mcp' },
            batchSize: { type: 'number', minimum: 1, maximum: 50 },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'tim_session_log',
        description: 'Append exchange entries to a session log.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'agent'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
              },
            },
          },
          required: ['sessionId', 'entries'],
        },
      },
      {
        name: 'tim_show_unsummarized',
        description:
          'Return the next unsummarized batch of exchanges for a session (UUIDs + user/agent bodies). Summarizer reads this, writes a Batch node under Summary.',
        inputSchema: {
          type: 'object',
          properties: { sessionId: { type: 'string' } },
          required: ['sessionId'],
        },
      },
      {
        name: 'tim_show_all_unsummarized',
        description:
          'Scan ALL sessions and return every unsummarized batch. Use at startup for cleanup sweep of stale batches (crashed summarizer, missed triggers). No parameters needed.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'tim_show_untagged',
        description:
          'Return batch-summary nodes that have only structural tags (#session-summary, #batch-summary) and no content hashtags. Use for re-tagging failed or legacy summaries.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'tim_write_batch_summary',
        description:
          'Write an idempotent Batch summary node under the session Summary tree. Used by tim-summarizer CLI.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            batchIndex: { type: 'number', minimum: 1 },
            summary: { type: 'string' },
            seqFrom: { type: 'number', minimum: 0 },
            seqTo: { type: 'number', minimum: 0 },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['sessionId', 'batchIndex', 'summary', 'seqFrom', 'seqTo'],
        },
      },
      {
        name: 'tim_record_commit',
        description:
          'Record a git commit under the project Commits section. Idempotent by hash. Links to session via relates/implements when sessionId given.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project label, e.g. P0063' },
            hash: { type: 'string', description: 'Full git commit SHA' },
            message: { type: 'string', description: 'Commit message' },
            diffSummary: { type: 'string', description: 'git show --stat output' },
            sessionId: { type: 'string', description: 'Session that produced this commit' },
            branch: { type: 'string' },
            author: { type: 'string' },
            date: { type: 'string', description: 'ISO 8601 commit date' },
          },
          required: ['projectId', 'hash', 'message'],
        },
      },
      {
        name: 'tim_checkpoint',
        description: 'Create a session checkpoint summary and run verify-before-decay.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'tim_rename_entry',
        description: 'Atomically rename an entry ID and update all references (edges, parent_id, staging, metadata).',
        inputSchema: {
          type: 'object',
          properties: {
            oldId: { type: 'string', description: 'Current entry ID' },
            newId: { type: 'string', description: 'New entry ID (must not exist)' },
          },
          required: ['oldId', 'newId'],
        },
      },
      {
        name: 'tim_move_entry',
        description: 'Move an entry under a new parent and cascade depth updates to descendants.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Entry ID to move' },
            newParentId: { type: ['string', 'null'], description: 'New parent ID, or null for root' },
          },
          required: ['id'],
        },
      },
      {
        name: 'tim_update_many',
        description: 'Batch-update irrelevant and/or favorite flags on multiple entries (flags only, never content).',
        inputSchema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
            irrelevant: { type: 'boolean' },
            favorite: { type: 'boolean' },
          },
          required: ['ids'],
        },
      },
      {
        name: 'tim_tag_add',
        description: 'Add tags to an entry (deduplicated).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          required: ['id', 'tags'],
        },
      },
      {
        name: 'tim_tag_remove',
        description: 'Remove tags from an entry.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          required: ['id', 'tags'],
        },
      },
      {
        name: 'tim_tag_rename',
        description: 'Rename a tag across all entries (exact match only, safe for substring collisions).',
        inputSchema: {
          type: 'object',
          properties: {
            oldTag: { type: 'string' },
            newTag: { type: 'string' },
          },
          required: ['oldTag', 'newTag'],
        },
      },
      {
        name: 'tim_create_project',
        description: 'Register a project entry so load_project can find it later.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Project label, e.g. P0062' },
            metadata: { type: 'object', default: {} },
            content: { type: 'string' },
            aliases: {
              type: 'array',
              items: { type: 'string' },
              description: 'Short names for tim_load_project, e.g. ["o9k", "hmem"]',
            },
          },
          required: ['label'],
        },
      },
      {
        name: 'tim_load_project',
        description:
          'Load a project by label or alias and bind the session once. Rejects a different project if the session is already bound — use tim_read_project for cross-project lookups.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Project label, e.g. P0062' },
            depth: { type: 'number', default: 3, description: 'How many child levels to load (1-5)' },
            budget: { type: 'number', default: 200, description: 'Max child entries to return' },
            sections: {
              type: ['array', 'null'],
              items: { type: 'string' },
              default: null,
              description: 'Optional section IDs/labels to filter direct children',
            },
          },
          required: ['label'],
        },
      },
      {
        name: 'tim_read_project',
        description:
          'Read a project brief + tree WITHOUT binding the session (cross-project lookup). Use tim_load_project to start working on a project.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Project label, e.g. P0062' },
            depth: { type: 'number', default: 3, description: 'How many child levels to load (1-5)' },
            budget: { type: 'number', default: 200, description: 'Max child entries to return' },
            sections: {
              type: ['array', 'null'],
              items: { type: 'string' },
              default: null,
              description: 'Optional section IDs/labels to filter direct children',
            },
          },
          required: ['label'],
        },
      },
      {
        name: 'tim_show',
        description:
          'Unified overview: tasks, errors, bugs, ideas, decisions, learnings, commits, sections, or all. ' +
          'Use root for project scope (omit=active, "all"=cross-project). ' +
          'Use with for comma-separated AND filters (open,done,urgent,recent,<tag>,<free text>).',
        inputSchema: {
          type: 'object',
          properties: {
            what: {
              type: 'string',
              description: 'tasks|errors|bugs|ideas|decisions|learnings|commits|all|<SectionName>',
            },
            root: {
              type: 'string',
              description: 'Project label/alias/name; "" or "all" = all projects; omit = active',
            },
            with: {
              type: 'string',
              description: 'Comma-separated AND filters: open,done,urgent,recent,<tag>,<free text>',
            },
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
          },
          required: ['what'],
        },
      },
      {
        name: 'tim_tasks',
        description:
          "[DEPRECATED — use tim_show what='tasks'] List open tasks across all projects, " +
          'grouped by project and sorted by status, priority, and due date.',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['todo', 'in_progress', 'done', 'cancelled'],
              description: 'Filter by task status. Default: todo + in_progress.',
            },
          },
        },
      },
      {
        name: 'tim_error_stats',
        description: 'Show error statistics: total errors, top errors, error rate, alert thresholds (>5 identical errors in 1h).',
        inputSchema: {
          type: 'object',
          properties: {
            hours: { type: 'number', default: 24, description: 'Time window in hours (1-720)' },
            limit: { type: 'number', default: 10, description: 'Max top errors to return' },
          },
        },
      },
      {
        name: 'tim_error_log',
        description: 'Log an error entry. Used by CLI tools and summarizer for structured error tracking.',
        inputSchema: {
          type: 'object',
          properties: {
            tool: { type: 'string', description: 'Tool name, e.g. "summarizer/codex"' },
            error: { type: 'string', description: 'Error message' },
            stack: { type: 'string', description: 'Stack trace (optional)' },
            sessionId: { type: 'string', description: 'Associated session ID (optional)' },
            args: { type: 'object', description: 'Tool arguments (optional)' },
          },
          required: ['tool', 'error'],
        },
      },
    ],
  }));

  // ─── Tool Handler ────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const s = getStore();
    const { name, arguments: args } = request.params;
    scheduleAutoSync(name, s);

    try {
      switch (name) {
        case 'tim_read': {
          const {
            id,
            project,
            section,
            depth,
            includeEdges,
            includeChildren,
            showIrrelevant,
          } = TimReadSchema.parse(args);
          const readOpts = { depth, includeChildren, showIrrelevant };

          if (Array.isArray(id)) {
            let projectLabel: string | null = null;
            if (project) {
              const pr = await s.resolveProjectLabel(project);
              if (pr.status === 'ambiguous') {
                return {
                  content: [{ type: 'text', text: `ambiguous project: ${pr.labels.join(', ')}` }],
                  isError: true,
                };
              }
              if (pr.status !== 'found') {
                return {
                  content: [{ type: 'text', text: `project not found: ${project}` }],
                  isError: true,
                };
              }
              projectLabel = pr.label;
            }
            const entries: Entry[] = [];
            const missing: string[] = [];
            for (const entryId of id) {
              const entry = await s.read(entryId, readOpts);
              if (!entry) {
                missing.push(entryId);
                continue;
              }
              if (projectLabel && s.getProjectLabel(entry.id) !== projectLabel) {
                missing.push(entryId);
                continue;
              }
              entries.push(entry);
            }
            return {
              content: [{ type: 'text', text: JSON.stringify({ entries, missing }, null, 2) }],
            };
          }

          if (section) {
            let projectLabel = project;
            if (!projectLabel) {
              const roots = await resolveRoots(s, undefined);
              if (roots.error) {
                return {
                  content: [{ type: 'text', text: roots.error }],
                  isError: true,
                };
              }
              if (roots.labels!.length !== 1) {
                return {
                  content: [{
                    type: 'text',
                    text: 'section read requires a single project (pass project or bind one)',
                  }],
                  isError: true,
                };
              }
              projectLabel = roots.labels![0];
            }
            const pr = await s.resolveProjectLabel(projectLabel);
            if (pr.status !== 'found') {
              return {
                content: [{ type: 'text', text: `project not found: ${projectLabel}` }],
                isError: true,
              };
            }
            const projEntry = await s.read(pr.label);
            if (!projEntry) {
              return {
                content: [{ type: 'text', text: `project not found: ${projectLabel}` }],
                isError: true,
              };
            }
            const sec = await s.resolveSectionByTitle(projEntry.id, section);
            if (sec.status === 'ambiguous') {
              return {
                content: [{
                  type: 'text',
                  text: `ambiguous section '${section}': ${sec.candidates.map(c => c.id).join(', ')}`,
                }],
                isError: true,
              };
            }
            if (sec.status !== 'found') {
              return {
                content: [{
                  type: 'text',
                  text: `section not found: ${section} (candidates: ${sec.candidates.join(', ')})`,
                }],
                isError: true,
              };
            }
            const sectionEntry = await s.read(sec.id, readOpts);
            const children = await s.getChildren(sec.id);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ section: sectionEntry, children }, null, 2),
              }],
            };
          }

          if (project && id === undefined) {
            const pr = await s.resolveProjectLabel(project);
            if (pr.status === 'ambiguous') {
              return {
                content: [{ type: 'text', text: `ambiguous project: ${pr.labels.join(', ')}` }],
                isError: true,
              };
            }
            if (pr.status !== 'found') {
              return {
                content: [{ type: 'text', text: `project not found: ${project}` }],
                isError: true,
              };
            }
            const entry = await s.read(pr.label, readOpts);
            if (!entry) {
              return {
                content: [{ type: 'text', text: JSON.stringify(null) }],
                isError: true,
              };
            }
            const edges = includeEdges ? await s.getEdges(entry.id, 'both') : [];
            return {
              content: [{ type: 'text', text: JSON.stringify({ entry, edges }, null, 2) }],
            };
          }

          if (typeof id === 'string') {
            let projectLabel: string | null = null;
            if (project) {
              const pr = await s.resolveProjectLabel(project);
              if (pr.status === 'ambiguous') {
                return {
                  content: [{ type: 'text', text: `ambiguous project: ${pr.labels.join(', ')}` }],
                  isError: true,
                };
              }
              if (pr.status !== 'found') {
                return {
                  content: [{ type: 'text', text: `project not found: ${project}` }],
                  isError: true,
                };
              }
              projectLabel = pr.label;
            }
            const entry = await s.read(id, readOpts);
            if (!entry) {
              return {
                content: [{ type: 'text', text: JSON.stringify(null) }],
                isError: true,
              };
            }
            if (projectLabel && s.getProjectLabel(entry.id) !== projectLabel) {
              return {
                content: [{ type: 'text', text: JSON.stringify(null) }],
                isError: true,
              };
            }
            const edges = includeEdges ? await s.getEdges(id, 'both') : [];
            return {
              content: [{ type: 'text', text: JSON.stringify({ entry, edges }, null, 2) }],
            };
          }

          return {
            content: [{ type: 'text', text: 'tim_read requires one of: id, project, section' }],
            isError: true,
          };
        }

        case 'tim_write': {
          const opts = TimWriteSchema.parse(args);
          const { parentTitle, projectId, where, ...writeOpts } = opts;

          if (!writeOpts.parentId && where) {
            const parts = where.split('/');
            const projPart = parts[0]?.trim();
            const secPart = parts.slice(1).join('/').trim();
            if (!projPart || !secPart) {
              return {
                content: [{
                  type: 'text',
                  text: `Invalid where shorthand '${where}' — expected P0062/Tasks`,
                }],
                isError: true,
              };
            }
            const pr = await s.resolveProjectLabel(projPart);
            if (pr.status === 'ambiguous') {
              return {
                content: [{
                  type: 'text',
                  text: `ambiguous project in where: ${pr.labels.join(', ')}`,
                }],
                isError: true,
              };
            }
            if (pr.status !== 'found') {
              return {
                content: [{ type: 'text', text: `project not found in where: ${projPart}` }],
                isError: true,
              };
            }
            const projEntry = await s.read(pr.label);
            if (!projEntry) {
              return {
                content: [{ type: 'text', text: `project not found in where: ${projPart}` }],
                isError: true,
              };
            }
            const sr = await s.resolveSectionByTitle(projEntry.id, secPart);
            if (sr.status === 'ambiguous') {
              return {
                content: [{
                  type: 'text',
                  text: `ambiguous section '${secPart}': ${sr.candidates.map(c => `${c.title} (${c.id})`).join(', ')}`,
                }],
                isError: true,
              };
            }
            if (sr.status !== 'found') {
              return {
                content: [{
                  type: 'text',
                  text: `section not found: ${secPart} (candidates: ${sr.candidates.join(', ')})`,
                }],
                isError: true,
              };
            }
            writeOpts.parentId = sr.id;
          }

          if (!writeOpts.parentId && parentTitle) {
            if (!projectId) {
              return {
                content: [{ type: 'text', text: 'projectId required when using parentTitle' }],
                isError: true,
              };
            }
            const row = s.getDb().prepare(`
              SELECT e.id FROM entries e
              JOIN entries p ON e.parent_id = p.id
              WHERE json_extract(p.metadata, '$.label') = ?
                AND e.title = ?
            `).get(projectId, parentTitle) as { id: string } | undefined;

            if (!row) {
              return {
                content: [{
                  type: 'text',
                  text: `Parent section '${parentTitle}' not found in project '${projectId}'`,
                }],
                isError: true,
              };
            }
            writeOpts.parentId = row.id;
          }

          // Enforce tags for non-schema entries. Schema entries (sections,
          // project roots, sessions, exchanges, batch summaries, commits,
          // checkpoints) are exempt — everything else is user content and
          // must carry at least 2 tags for discoverability.
          const tagsValidation = validateWriteTags(writeOpts.tags, writeOpts.metadata);
          if (!tagsValidation.ok) {
            return {
              content: [{ type: 'text', text: JSON.stringify(tagsValidation, null, 2) }],
              isError: true,
            };
          }

          const entry = await s.write(opts.content, writeOpts);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_search': {
          const { query, topK, root, type, tag, status } = TimSearchSchema.parse(args);
          const hasFilters = Boolean(root || type || tag || status);
          let results = await s.searchFts(query, hasFilters ? 1000 : topK);
          if (root) {
            const roots = await resolveRoots(s, root);
            if (roots.error) {
              return {
                content: [{ type: 'text', text: roots.error }],
                isError: true,
              };
            }
            results = results.filter(r =>
              roots.labels!.includes(s.getProjectLabel(r.id) ?? ''),
            );
          }
          if (type) {
            results = results.filter(r => r.metadata.type === type);
          }
          if (tag) {
            const tg = tag.startsWith('#') ? tag : `#${tag}`;
            results = results.filter(r => r.tags.includes(tg) || r.tags.includes(tag));
          }
          if (status) {
            results = results.filter(r => r.metadata.status === status);
          }
          if (hasFilters) {
            results = results.slice(0, topK);
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }

        case 'tim_link': {
          const { sourceId, targetId, type, weight, metadata } = TimLinkSchema.parse(args);
          const edge = await s.link(sourceId, targetId, type as EdgeType, weight, metadata);
          return {
            content: [{ type: 'text', text: JSON.stringify(edge, null, 2) }],
          };
        }

        case 'tim_trace': {
          const { startId, edgeType, depth } = TimTraceSchema.parse(args);
          const chain = await s.traceChain(startId, edgeType as EdgeType | undefined, depth);
          return {
            content: [{ type: 'text', text: JSON.stringify(chain, null, 2) }],
          };
        }

        case 'tim_update': {
          const { id, ...patch } = TimUpdateSchema.parse(args);
          const entry = await s.update(id, patch as any);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_delete': {
          const { id, hard } = TimDeleteSchema.parse(args);
          await s.delete(id, hard);
          return {
            content: [{ type: 'text', text: `Entry ${id} ${hard ? 'hard-deleted' : 'marked irrelevant'}` }],
          };
        }

        case 'tim_sync': {
          const { action, stagingRecords } = TimSyncSchema.parse(args);
          switch (action) {
            case 'push': {
              if (!stagingRecords?.length) {
                return { content: [{ type: 'text', text: 'No staging records to push' }] };
              }
              await s.applyStaging(stagingRecords.map(r => ({
                key: r.key,
                entityType: r.entityType,
                operation: r.operation,
                payload: r.payload,
                lwwTimestamp: r.lwwTimestamp,
                lwwDevice: r.lwwDevice,
                lwwConfidence: r.lwwConfidence,
                acked: r.acked ?? false,
              })));
              return { content: [{ type: 'text', text: `Applied ${stagingRecords.length} staging records` }] };
            }
            case 'status': {
              const cursor = await s.getStagingCursor();
              const pending = await s.getStaging();
              return {
                content: [{ type: 'text', text: JSON.stringify({ cursor, pendingCount: pending.length }) }],
              };
            }
            case 'pull': {
              const config = loadSyncConfig();
              if (!config) {
                return { content: [{ type: 'text', text: 'Sync not configured (set TIM_SYNC_PASSPHRASE and tim-sync config)' }] };
              }
              // Force re-arm: manual pull bypasses cooldown + in-flight guard
              resetSyncCooldowns();
              const result = await autoPull(s);
              const cursor = await s.getStagingCursor();
              return {
                content: [{ type: 'text', text: JSON.stringify({
                  pulled: result.pulled ?? 0,
                  conflicts: result.conflicts ?? 0,
                  cursor,
                  timestamp: new Date().toISOString(),
                }) }],
              };
            }
            default:
              return { content: [{ type: 'text', text: `Sync action '${action}' not yet implemented` }] };
          }
        }

        case 'tim_lease': {
          const { grant, revoke, entryId, ttl } = TimLeaseSchema.parse(args);
          if (grant) {
            const agents = await s.getAgents();
            const agent = agents.find(a => a.label === grant);
            if (!agent) return { content: [{ type: 'text', text: `Agent "${grant}" not registered` }] };
            await s.link(entryId, agent.id, 'leases', 1.0, ttl ? { ttl } : {});
            return { content: [{ type: 'text', text: `Leased entry ${entryId} to ${grant}` + (ttl ? ` (TTL: ${ttl})` : '') }] };
          }
          if (revoke) {
            const edges = await s.getEdges(entryId, 'outgoing');
            const leaseEdge = edges.find(e => e.type === 'leases');
            if (leaseEdge) {
              await s.unlink(leaseEdge.id);
              return { content: [{ type: 'text', text: `Revoked lease on ${entryId}` }] };
            }
            return { content: [{ type: 'text', text: `No active lease found for ${entryId}` }] };
          }
          return { content: [{ type: 'text', text: 'Specify grant= or revoke=' }] };
        }

        case 'tim_suppress': {
          const { pattern, reason, ttl } = TimSuppressSchema.parse(args);
          await s.suppress(pattern, reason, ttl);
          return {
            content: [{ type: 'text', text: `Suppressed pattern "${pattern}"` + (ttl ? ` until ${ttl}` : '') }],
          };
        }

        case 'tim_health': {
          const report = await s.health();
          return {
            content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
          };
        }

        case 'tim_stats': {
          const stats = await s.stats();
          return {
            content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
          };
        }

        case 'tim_export': {
          const { format, targetPath } = TimExportSchema.parse(args);
          const exportFormat = format === 'md' ? 'text' : format;
          if (exportFormat === 'text') {
            const md = tim_export(s, undefined, { format: 'text' });
            return { content: [{ type: 'text', text: md }] };
          }
          const outPath = targetPath ?? path.join(os.tmpdir(), `tim-export-${Date.now()}.hmem`);
          const result = tim_export(s, outPath, { format: 'hmem' });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'tim_import': {
          const { source, dryRun, deduplicate } = TimImportSchema.parse(args);
          if (!fs.existsSync(source)) {
            return { content: [{ type: 'text', text: `Source not found: ${source}` }] };
          }
          const report = tim_import(s, source, { dryRun, deduplicate });
          return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
        }

        case 'tim_doctor': {
          const report = await s.health();
          const stats = await s.stats();
          const agents = await s.getAgents();
          const errorStats = getErrorLogger().getStats({ hours: 24, limit: 5 });
          const text = [
            `TIM Doctor — ${DB_PATH}`,
            `Entries: ${stats.totalEntries} | Edges: ${stats.totalEdges}`,
            `Broken links: ${report.brokenLinks} | Orphans: ${report.orphanEntries}`,
            `FTS5: ${report.ftsIntegrity ? 'OK' : 'BROKEN'}`,
            `Agents registered: ${agents.length}`,
            `Errors (24h): ${errorStats.totalErrors} | Rate: ${errorStats.errorRate}/h`,
            errorStats.alerts.length > 0 ? `⚠ Alerts: ${errorStats.alerts.join('; ')}` : null,
            ...report.issues.map(i => `⚠ ${i}`),
          ].filter(Boolean).join('\n');
          return { content: [{ type: 'text', text }] };
        }

        case 'tim_session_start': {
          const { sessionId, projectId, agentName, cwd, harness, batchSize, tool, model, taskSummary } =
            TimSessionStartSchema.parse(args);
          const cwdResolved = cwd ?? process.cwd();
          let boundProjectId = projectId ?? getActiveProjectLabel() ?? undefined;
          if (!boundProjectId) {
            await ensureInboxProject(s);
            boundProjectId = INBOX_PROJECT_LABEL;
          }
          const entry = await getSessions().startProjectSession({
            sessionId,
            projectId: boundProjectId,
            agentName,
            cwd: cwdResolved,
            harness,
            batchSize,
            tool,
            model,
            taskSummary,
          });
          const cortex = await buildCortexReadyBlock(s, entry);
          const text = cortex
            ? `${cortex}\n\n${JSON.stringify(entry, null, 2)}`
            : JSON.stringify(entry, null, 2);
          return {
            content: [{ type: 'text', text }],
          };
        }

        case 'tim_session_log': {
          const { sessionId, entries } = TimSessionLogSchema.parse(args);
          const sessionEntry = await s.read(sessionId);
          const isProjectBound =
            !!(sessionEntry && (await s.getChildByKind(sessionId, 'exchanges-root')).length > 0);
          const written = isProjectBound
            ? await getSessions().logExchange(sessionId, entries)
            : await getSessions().sessionLog(sessionId, entries);
          return {
            content: [{ type: 'text', text: JSON.stringify(written, null, 2) }],
          };
        }

        case 'tim_show_unsummarized': {
          const { sessionId } = TimShowUnsummarizedSchema.parse(args);
          const batch = await getSessions().showUnsummarized(sessionId);
          return {
            content: [{ type: 'text', text: JSON.stringify(batch, null, 2) }],
          };
        }

        case 'tim_show_all_unsummarized': {
          const batches = await getSessions().showAllUnsummarized();
          return {
            content: [{ type: 'text', text: JSON.stringify(batches, null, 2) }],
          };
        }

        case 'tim_show_untagged': {
          const untagged = await getSessions().showUntagged();
          return {
            content: [{ type: 'text', text: JSON.stringify(untagged, null, 2) }],
          };
        }

        case 'tim_write_batch_summary': {
          const { sessionId, batchIndex, summary, seqFrom, seqTo, tags } =
            TimWriteBatchSummarySchema.parse(args);
          const node = await getSessions().writeBatchSummary(sessionId, batchIndex, summary, {
            seqFrom,
            seqTo,
          }, tags);
          return {
            content: [{ type: 'text', text: JSON.stringify(node, null, 2) }],
          };
        }

        case 'tim_record_commit': {
          const parsed = TimRecordCommitSchema.parse(args);
          const entry = await getCommitManager().recordCommit(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_checkpoint': {
          const { sessionId } = TimCheckpointSchema.parse(args);
          const summary = await getSessions().checkpoint(sessionId);
          return {
            content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
          };
        }

        case 'tim_rename_entry': {
          const { oldId, newId } = TimRenameEntrySchema.parse(args);
          const entry = s.curate().renameEntry(oldId, newId);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_move_entry': {
          const { id, newParentId, order } = TimMoveEntrySchema.parse(args);
          const entry = s.curate().moveEntry(id, newParentId, order);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_update_many': {
          const { ids, irrelevant, favorite } = TimUpdateManySchema.parse(args);
          const entries = s.curate().updateMany(ids, { irrelevant, favorite });
          return {
            content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
          };
        }

        case 'tim_tag_add': {
          const { id, tags } = TimTagAddSchema.parse(args);
          const entry = s.curate().tagAdd(id, tags);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_tag_remove': {
          const { id, tags } = TimTagRemoveSchema.parse(args);
          const entry = s.curate().tagRemove(id, tags);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_tag_rename': {
          const { oldTag, newTag } = TimTagRenameSchema.parse(args);
          const count = s.curate().tagRename(oldTag, newTag);
          return {
            content: [{ type: 'text', text: JSON.stringify({ oldTag, newTag, updatedCount: count }, null, 2) }],
          };
        }

        case 'tim_create_project': {
          const { label, metadata, content, aliases } = TimCreateProjectSchema.parse(args);
          const entry = await s.createProject(label, { metadata, content, aliases });
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_load_project': {
          const { label, depth, budget, sections, sessionId: sessionIdArg } =
            TimLoadProjectSchema.parse(args);
          const resolved = await s.resolveProjectLabel(label);
          if (resolved.status === 'ambiguous') {
            return {
              content: [{
                type: 'text',
                text: `Ambiguous alias: matches ${resolved.labels.join(', ')}. Use label.`,
              }],
            };
          }
          if (resolved.status === 'not_found') {
            return { content: [{ type: 'text', text: `Project not found: ${label}` }] };
          }

          const projectLabel = resolved.label;
          const cwd = process.cwd();
          const sessionId = resolveActiveSessionId({
            sessionIdArg: sessionIdArg,
            markerSession: findMarker(cwd)?.marker.session,
          });

          if (sessionId) {
            const existing = await s.read(sessionId);
            if (existing?.metadata.kind === 'session') {
              const existingRef =
                typeof existing.metadata.project_ref === 'string'
                  ? existing.metadata.project_ref
                  : undefined;
              if (evaluateLoadGate(existingRef, projectLabel) === 'reject') {
                return {
                  content: [{
                    type: 'text',
                    text:
                      `Session already bound to ${existingRef}. tim_load_project binds once per session. ` +
                      'Use tim_read_project for cross-project access.',
                  }],
                };
              }
            }
          }

          const result = await s.loadProject(projectLabel, { depth, budget, sections });
          if (!result) {
            return { content: [{ type: 'text', text: `Project not found: ${label}` }] };
          }

          if (sessionId) {
            try {
              await getSessions().startProjectSession({
                sessionId,
                projectId: projectLabel,
                agentName: 'mcp',
                cwd,
                harness: 'mcp',
              });
            } catch {
              // Non-critical — project brief still returned
            }
          }

          try {
            syncNearestProjectMarker(cwd, projectLabel, { sessionId });
          } catch {
            // Non-critical — brief still returned
          }

          const formatted = formatProjectOutput(result, budget, loadProjectSchema(), 'load');
          return {
            content: [{
              type: 'text',
              text: formatted,
            }],
          };
        }

        case 'tim_read_project': {
          const { label, depth, budget, sections } = TimReadProjectSchema.parse(args);
          const resolved = await s.resolveProjectLabel(label);
          if (resolved.status === 'ambiguous') {
            return {
              content: [{
                type: 'text',
                text: `Ambiguous alias: matches ${resolved.labels.join(', ')}. Use label.`,
              }],
            };
          }
          if (resolved.status === 'not_found') {
            return { content: [{ type: 'text', text: `Project not found: ${label}` }] };
          }

          const result = await s.loadProject(resolved.label, { depth, budget, sections });
          if (!result) {
            return { content: [{ type: 'text', text: `Project not found: ${label}` }] };
          }

          const formatted = formatProjectOutput(result, budget, loadProjectSchema(), 'read');
          return {
            content: [{
              type: 'text',
              text: formatted,
            }],
          };
        }

        case 'tim_show': {
          const { what, root, with: withStr, limit } = TimShowSchema.parse(args);
          const roots = await resolveRoots(s, root);
          if ('error' in roots && roots.error) {
            return {
              content: [{ type: 'text', text: roots.error }],
              isError: true,
            };
          }
          let entries = await fetchByWhat(s, what, roots.labels!);
          entries = await applyWith(s, entries, withStr);
          entries = sortForShow(entries);
          entries = entries.slice(0, limit);
          const formatted = await formatShowOutput(s, entries);
          return {
            content: [{ type: 'text', text: formatted }],
          };
        }

        case 'tim_tasks': {
          const { status } = TimTasksSchema.parse(args);
          let tasks = await s.getTasks(status ? { status } : undefined);
          if (!status) {
            tasks = tasks.filter(t =>
              t.status === 'todo' || t.status === 'in_progress' || t.status == null,
            );
          }
          const formatted = await formatTasksOutput(s, tasks);
          return {
            content: [{ type: 'text', text: formatted }],
          };
        }

        case 'tim_error_stats': {
          const { hours, limit } = TimErrorStatsSchema.parse(args);
          const stats = getErrorLogger().getStats({ hours, limit });
          const text = [
            `=== ERROR STATS (last ${hours}h) ===`,
            `Total errors: ${stats.totalErrors} | Error rate: ${stats.errorRate}/h`,
            `--- Top Errors ---`,
            ...stats.topErrors.map((e: { count: number; error: string; lastSeen: string }, i: number) =>
              `  ${i + 1}. [${e.count}x] ${e.error} (last: ${e.lastSeen})`
            ),
            `--- By Tool ---`,
            ...stats.byTool.map((t: { tool: string; count: number }) => `  ${t.tool}: ${t.count}`),
            stats.alerts.length > 0 ? `--- ALERTS ---` : '',
            ...stats.alerts.map((a: string) => `  ${a}`),
          ].filter((l: string) => l !== '').join('\n');
          return { content: [{ type: 'text', text }] };
        }

        case 'tim_error_log': {
          const { tool, error, stack, sessionId, args: toolArgs } = TimErrorLogSchema.parse(args);
          getErrorLogger().logError({ tool, error, stack, sessionId, args: toolArgs });
          return { content: [{ type: 'text', text: JSON.stringify({ logged: true }) }] };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error: any) {
      getErrorLogger().logError({
        tool: name,
        args,
        error: error.message ?? String(error),
        stack: error.stack,
      });
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ─── Start ────────────────────────────────────────────

  // BUG 4: Global error guards — keep the stdio server alive when an
  // async tool handler or fire-and-forget promise throws OUTSIDE the
  // dispatcher try/catch. Without these, Node 24's default behavior is
  // to crash the process on any unhandled rejection, killing the MCP
  // server and triggering the client's auto-retry cooldown.
  // We log to stderr + persist via ErrorLogger + stay alive.
  process.on('unhandledRejection', (reason, promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[tim-mcp] unhandledRejection:', err.stack ?? err.message);
    try {
      getErrorLogger().logError({
        tool: 'mcp-server',
        error: `unhandledRejection: ${err.message}`,
        stack: err.stack,
      });
    } catch {
      // ErrorLogger itself failed — nothing more we can do, stay alive.
    }
  });

  process.on('uncaughtException', (err) => {
    console.error('[tim-mcp] uncaughtException:', err.stack ?? err.message);
    try {
      getErrorLogger().logError({
        tool: 'mcp-server',
        error: `uncaughtException: ${err.message}`,
        stack: err.stack,
      });
    } catch {
      // Same as above.
    }
    // Note: we intentionally do NOT call process.exit(). The stdio pipe
    // stays open and subsequent MCP requests continue to be served. The
    // MCP SDK's processReadBuffer() already wraps readMessage() in
    // try/catch (see @modelcontextprotocol/sdk/dist/esm/server/stdio.js),
    // so a malformed input frame cannot kill the server either.
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TIM MCP server started (DB: ${DB_PATH})`);
}

// Run if executed directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  startServer().catch(console.error);
}
