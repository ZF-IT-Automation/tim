import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';
import { CHARS_PER_TOKEN } from 'tim-store';
import {
  boundRenderedText,
  chargePartialTokens,
  createTokenBudget,
  estimateTextTokens,
  tryChargeTokens,
  type TokenBudgetLedger,
} from './briefing-budget.js';

/** Reserved tiers — lower number = higher priority, never displaced by lower tiers. */
export const BRIEFING_PRIORITY = {
  header: 0,
  activeRules: 1,
  urgentTasks: 2,
  recentSession: 3,
  general: 4,
  queryExtras: 5,
  log: 6,
} as const;

export type BriefingPriority = typeof BRIEFING_PRIORITY[keyof typeof BRIEFING_PRIORITY];

export interface TaskAwareBriefingOptions {
  tokenBudget: number;
  query?: string;
  ftsQueryMode?: 'literal' | 'or-terms';
  /** When false, skip query-driven extras (legacy callers). */
  includeQueryExtras?: boolean;
}

export interface BriefingBlock {
  id: string;
  priority: BriefingPriority;
  lines: string[];
  /** Display order among blocks of equal priority (lower first). */
  order: number;
  /** Exact MCP call to expand collapsed/truncated content from this block. */
  drillDown?: string;
}

export interface BriefingSelectionResult {
  blocks: BriefingBlock[];
  ledger: TokenBudgetLedger;
  omissions: string[];
  queryHits: Entry[];
}

const LOG_SECTION_NAMES = new Set(['log', 'logs']);
const RULES_SECTION_NAMES = new Set(['rules', 'agent rules']);
const TASKS_SECTION_NAMES = new Set(['tasks', 'next steps']);

function sectionPriority(name: string, isRecentSessions: boolean): BriefingPriority {
  const lower = name.toLowerCase();
  if (isRecentSessions) return BRIEFING_PRIORITY.recentSession;
  if (RULES_SECTION_NAMES.has(lower) || lower.includes('rule')) return BRIEFING_PRIORITY.activeRules;
  if (TASKS_SECTION_NAMES.has(lower)) return BRIEFING_PRIORITY.urgentTasks;
  if (LOG_SECTION_NAMES.has(lower)) return BRIEFING_PRIORITY.log;
  return BRIEFING_PRIORITY.general;
}

function blockTokenCost(block: BriefingBlock): number {
  return estimateTextTokens(block.lines.join('\n'));
}

function firstNonEmptyLineIndex(lines: string[]): number {
  return lines.findIndex(line => line.trim().length > 0);
}

function sectionDrillDown(blockId: string): string | undefined {
  if (!blockId.startsWith('section:')) return undefined;
  const sectionId = blockId.slice('section:'.length);
  return sectionId ? `tim_read("${sectionId}")` : undefined;
}

function blockDrillDown(block: BriefingBlock): string | undefined {
  return block.drillDown ?? sectionDrillDown(block.id);
}

function sectionTitleOnlyLine(block: BriefingBlock): string | null {
  if (!block.id.startsWith('section:')) return null;
  const drillDown = blockDrillDown(block);
  if (!drillDown) return null;
  const titleLine = block.lines.find(line => line.trim().length > 0 && !line.includes('──'));
  if (!titleLine) return null;
  const name = titleLine.trim();
  return `  ${name} — ${drillDown}`;
}

/** Partial inclusion: keep leading spacers, first heading, and bounded body when feasible. */
function tryPartialBlockInclusion(
  ledger: TokenBudgetLedger,
  separator: string,
  block: BriefingBlock,
): { block: BriefingBlock | null; omission: string | null } {
  const firstIdx = firstNonEmptyLineIndex(block.lines);
  if (firstIdx < 0) return { block: null, omission: null };

  const drillDown = blockDrillDown(block);
  const titleOnly = sectionTitleOnlyLine(block);
  const prefixLines = block.lines.slice(0, firstIdx + 1);
  const prefixText = prefixLines.join('\n');
  if (!tryChargeTokens(ledger, separator + prefixText)) {
    if (titleOnly && tryChargeTokens(ledger, separator + titleOnly)) {
      const omission = `${block.id}: body omitted (token budget) — ${drillDown}`;
      return { block: { ...block, lines: [titleOnly] }, omission };
    }
    return { block: null, omission: null };
  }

  const outLines = [...prefixLines];
  const restText = block.lines.slice(firstIdx + 1).join('\n');
  let truncated = false;
  if (restText && ledger.remaining > 1) {
    tryChargeTokens(ledger, '\n');
    const partial = chargePartialTokens(
      ledger,
      restText,
      undefined,
      block.id.startsWith('section:') ? drillDown : undefined,
    );
    truncated = partial.truncated;
    if (truncated && titleOnly) {
      outLines.length = firstIdx + 1;
      outLines[firstIdx] = titleOnly;
    } else if (partial.text) {
      outLines.push(...partial.text.split('\n'));
    }
  }

  const omittedLines = block.lines.length - outLines.length;
  let omission: string | null = null;
  if (truncated) {
    omission = drillDown
      ? `${block.id}: truncated (token budget) — ${drillDown}`
      : `${block.id}: truncated (token budget)`;
  } else if (omittedLines > 0) {
    omission = drillDown
      ? `${block.id}: ${omittedLines} lines omitted (token budget) — ${drillDown}`
      : `${block.id}: ${omittedLines} lines omitted (token budget)`;
  }
  return { block: { ...block, lines: outLines }, omission };
}

/** Allocate blocks by reserved priority; returns included blocks in display order. */
export function selectBriefingBlocks(
  blocks: BriefingBlock[],
  tokenBudget: number,
): { included: BriefingBlock[]; omissions: string[]; ledger: TokenBudgetLedger } {
  const ledger = createTokenBudget(tokenBudget);
  const omissions: string[] = [];
  const sorted = [...blocks].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.order - b.order;
  });

  const nowSource = sorted.find(
    block => block.id === 'now' && block.lines.some(line => line.trim().startsWith('- [')),
  );
  const rulesSource = sorted.find(block => block.id === 'rules');
  const rulesLines = rulesSource?.lines.filter(
    line => line.includes('── Rules ──')
      || (line.trim().length > 0 && line.trim() !== 'Rules'),
  ) ?? [];

  let pinnedNow: BriefingBlock | null = null;
  if (nowSource) {
    // Drop only blank lines: an allowlist lost the triage instruction and the overflow count.
    let compactLines = nowSource.lines.filter(line => line.trim().length > 0);
    // Under a tight budget the task ids go before the rules do (tim_show recovers ids).
    const both = estimateTextTokens(compactLines.join('\n')) + estimateTextTokens(rulesLines.join('\n'));
    if (rulesSource && both > ledger.remaining) {
      compactLines = compactLines.map(line => line.replace(/ · [A-Za-z0-9_-]{10,}$/, ''));
    }
    if (tryChargeTokens(ledger, compactLines.join('\n'))) {
      pinnedNow = { ...nowSource, lines: compactLines };
    }
  }

  let pinnedRules: BriefingBlock | null = null;
  if (rulesSource && tryChargeTokens(ledger, rulesLines.join('\n'))) {
    pinnedRules = { ...rulesSource, lines: rulesLines };
  }

  const included: BriefingBlock[] = [];
  for (const block of sorted) {
    if (block.id === 'now' && pinnedNow) {
      included.push(pinnedNow);
      continue;
    }
    if (block.id === 'rules' && pinnedRules) {
      included.push(pinnedRules);
      continue;
    }
    const text = block.lines.join('\n');
    const separator = included.length ? '\n' : '';

    if (tryChargeTokens(ledger, separator + text)) {
      included.push(block);
      continue;
    }
    const partial = tryPartialBlockInclusion(ledger, separator, block);
    if (partial.block) {
      included.push(partial.block);
      if (partial.omission) omissions.push(partial.omission);
      continue;
    }
    // The sections index already names every section with its drill-down; a title-only
    // fallback would repeat that line.
    const indexed = included.some(b => b.id === 'sections-index');
    const titleOnly = indexed ? null : sectionTitleOnlyLine(block);
    if (titleOnly && tryChargeTokens(ledger, separator + titleOnly)) {
      included.push({ ...block, lines: [titleOnly] });
      const drillDown = blockDrillDown(block);
      omissions.push(drillDown
        ? `${block.id}: omitted (token budget) — ${drillDown}`
        : `${block.id}: omitted (token budget)`);
      continue;
    }
    const drillDown = blockDrillDown(block);
    omissions.push(drillDown
      ? `${block.id}: omitted (token budget) — ${drillDown}`
      : `${block.id}: omitted (token budget)`);
  }

  included.sort((a, b) => a.order - b.order);
  return { included, omissions, ledger };
}

const RESERVED_CONTENT_PRIORITIES = new Set<BriefingPriority>([
  BRIEFING_PRIORITY.header,
  BRIEFING_PRIORITY.activeRules,
  BRIEFING_PRIORITY.urgentTasks,
  BRIEFING_PRIORITY.recentSession,
]);

function mergeBlockSelections(
  a: { included: BriefingBlock[]; omissions: string[]; ledger: TokenBudgetLedger },
  b: { included: BriefingBlock[]; omissions: string[]; ledger: TokenBudgetLedger },
): { included: BriefingBlock[]; omissions: string[]; ledger: TokenBudgetLedger } {
  return {
    included: [...a.included, ...b.included].sort((x, y) => x.order - y.order),
    omissions: [...a.omissions, ...b.omissions],
    ledger: {
      limit: a.ledger.limit,
      used: a.ledger.used + b.ledger.used + (a.included.length && b.included.length ? 1 : 0),
      remaining: b.ledger.remaining,
    },
  };
}

/** Pack content blocks; reserved tiers (rules/tasks/sessions) keep a guaranteed slice. */
function selectContentBriefingBlocks(
  blocks: BriefingBlock[],
  tokenBudget: number,
): { included: BriefingBlock[]; omissions: string[]; ledger: TokenBudgetLedger } {
  const reserved = blocks.filter(block => RESERVED_CONTENT_PRIORITIES.has(block.priority));
  const general = blocks.filter(block => !RESERVED_CONTENT_PRIORITIES.has(block.priority));

  if (reserved.length === 0) {
    return selectBriefingBlocks(blocks, tokenBudget);
  }

  const minReservedCost = reserved.reduce(
    (sum, block, index) => sum + blockTokenCost(block) + (index > 0 ? 1 : 0),
    0,
  );
  let reservedBudget = Math.min(
    tokenBudget,
    Math.max(minReservedCost, Math.max(60, Math.floor(tokenBudget * 0.45))),
  );
  let reservedResult = selectBriefingBlocks(reserved, reservedBudget);
  let reservedUsed = reservedResult.ledger.used;

  while (
    reservedResult.omissions.some(o => o.includes('(token budget)'))
    && reservedBudget < tokenBudget
  ) {
    reservedBudget = Math.min(tokenBudget, reservedBudget + 40);
    reservedResult = selectBriefingBlocks(reserved, reservedBudget);
    reservedUsed = reservedResult.ledger.used;
  }

  const generalBudget = Math.max(0, tokenBudget - reservedUsed - (reservedResult.included.length ? 1 : 0));
  const generalResult = selectBriefingBlocks(general, generalBudget);
  return mergeBlockSelections(reservedResult, generalResult);
}

function clipBriefingLines(text: string, maxBytes: number): string {
  if (!text || maxBytes <= 0) return '';
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxBytes) break;
    used += cost;
    kept.push(line);
  }
  return kept.join('\n');
}

function formatOmissionsLine(omissions: string[], maxTokens: number): string {
  if (omissions.length === 0) return '';
  const full = `… briefing omissions: ${omissions.join('; ')}`;
  if (estimateTextTokens(full) <= maxTokens) return full;
  const summary = omissions.length === 1
    ? `… briefing omissions: ${omissions[0]}`
    : `… briefing omissions: ${omissions.length} blocks omitted (token budget)`;
  if (estimateTextTokens(summary) <= maxTokens) return summary;
  return boundRenderedText(summary, maxTokens).text;
}

/** Shared selection + whole-response bounding for load and preview MCP surfaces. */
export function assembleBoundedBriefingText(
  blocks: BriefingBlock[],
  tokenBudget: number,
  trailingParts: string[] = [],
  briefingDrillDown?: string,
): { text: string; omissions: string[]; truncated: boolean } {
  const footerBlocks = blocks.filter(block => block.id === 'footer');
  const contentBlocks = blocks.filter(block => block.id !== 'footer');

  const tailLines: string[] = [];
  for (const block of footerBlocks) tailLines.push(...block.lines);
  for (const part of trailingParts) {
    if (part) tailLines.push(part);
  }
  const tailText = tailLines.length > 0 ? tailLines.join('\n') : '';
  const tailCost = tailText ? estimateTextTokens(tailText) : 0;

  // Impossibly tiny budgets: footer cannot be reserved — compete fairly, then clamp once.
  if (tailCost <= 0 || tailCost >= tokenBudget) {
    const { included, omissions } = selectBriefingBlocks(blocks, tokenBudget);
    const outLines: string[] = [];
    for (const block of included) outLines.push(...block.lines);
    const omissionsLine = formatOmissionsLine(omissions, Math.max(0, tokenBudget - estimateTextTokens(outLines.join('\n'))));
    if (omissionsLine) outLines.push('', omissionsLine);
    const bounded = boundRenderedText(outLines.join('\n'), tokenBudget, briefingDrillDown);
    return {
      text: bounded.text,
      omissions,
      truncated: bounded.truncated || omissions.length > 0,
    };
  }

  // Reserve the newline between content and the protected tail as well as the tail itself.
  const contentLimit = Math.max(0, tokenBudget - tailCost - 1);
  const omissionsReserve = Math.min(80, contentLimit);
  const contentBudget = Math.max(0, contentLimit - omissionsReserve);

  const { included, omissions } = selectContentBriefingBlocks(contentBlocks, contentBudget);
  const contentLines: string[] = [];
  for (const block of included) contentLines.push(...block.lines);
  const omissionsLine = formatOmissionsLine(
    omissions,
    Math.max(0, contentLimit - estimateTextTokens(contentLines.join('\n')) - 2),
  );
  if (omissionsLine) contentLines.push('', omissionsLine);

  const contentJoined = contentLines.join('\n');
  const contentEstimate = estimateTextTokens(contentJoined);
  const contentBounded = contentEstimate > contentLimit
    ? { text: clipBriefingLines(contentJoined, contentLimit * CHARS_PER_TOKEN), truncated: true }
    : { text: contentJoined, truncated: false, estimatedTokens: contentEstimate };

  const parts: string[] = [];
  if (contentBounded.text) parts.push(contentBounded.text);
  if (tailText) parts.push(tailText);
  const joined = parts.join('\n');
  const finalEstimate = estimateTextTokens(joined);
  const truncated = contentBounded.truncated
    || omissions.length > 0
    || finalEstimate > tokenBudget;

  return {
    text: joined,
    omissions,
    truncated,
  };
}

export function renderSelectedBlocks(blocks: BriefingBlock[]): string {
  return blocks.map(b => b.lines.join('\n')).join('\n');
}

/** Project-scoped FTS extras for an optional task query. Respects store suppression. */
export async function searchTaskBriefingExtras(
  store: TimStore,
  projectLabel: string,
  query: string,
  ftsQueryMode: 'literal' | 'or-terms' = 'literal',
  topK = 5,
): Promise<Entry[]> {
  const q = query.trim();
  if (!q) return [];

  const hits = await store.search({
    query: q,
    project: projectLabel,
    topK,
    searchType: 'fts',
    ftsQueryMode,
  });
  return hits.filter(e => e.metadata.kind !== 'project');
}

export function formatQueryExtrasBlock(entries: Entry[], query: string): BriefingBlock | null {
  if (entries.length === 0) return null;
  const lines = [
    '── Task context ──',
    `(query: ${query})`,
    ...entries.map(e => {
      const title = e.title.trim() || e.content.split('\n')[0]?.trim() || e.id;
      const preview = e.content.replace(/\s+/g, ' ').trim().slice(0, 120);
      return preview ? `- ${title}: ${preview}` : `- ${title}`;
    }),
  ];
  return {
    id: 'task-query-extras',
    priority: BRIEFING_PRIORITY.queryExtras,
    order: 960,
    lines,
  };
}

export function logSectionOmission(count: number, shown: number, sectionId: string): string {
  const hidden = count - shown;
  if (hidden <= 0) return '';
  return `… ${hidden} log ${hidden === 1 ? 'entry' : 'entries'} omitted — tim_read("${sectionId}")`;
}

export { sectionPriority, TASKS_SECTION_NAMES, LOG_SECTION_NAMES, RULES_SECTION_NAMES };
