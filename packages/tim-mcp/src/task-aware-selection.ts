import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';
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

/** Partial inclusion: keep leading spacers, first heading, and bounded body when feasible. */
function tryPartialBlockInclusion(
  ledger: TokenBudgetLedger,
  separator: string,
  block: BriefingBlock,
): { block: BriefingBlock | null; omission: string | null } {
  const firstIdx = firstNonEmptyLineIndex(block.lines);
  if (firstIdx < 0) return { block: null, omission: null };

  const prefixLines = block.lines.slice(0, firstIdx + 1);
  const prefixText = prefixLines.join('\n');
  if (!tryChargeTokens(ledger, separator + prefixText)) {
    return { block: null, omission: null };
  }

  const outLines = [...prefixLines];
  const restText = block.lines.slice(firstIdx + 1).join('\n');
  let truncated = false;
  if (restText && ledger.remaining > 0) {
    const partial = chargePartialTokens(ledger, restText);
    truncated = partial.truncated;
    if (partial.text) outLines.push(...partial.text.split('\n'));
  }

  const omittedLines = block.lines.length - outLines.length;
  let omission: string | null = null;
  if (truncated) {
    omission = `${block.id}: truncated (token budget)`;
  } else if (omittedLines > 0) {
    omission = `${block.id}: ${omittedLines} lines omitted (token budget)`;
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

  const included: BriefingBlock[] = [];
  for (const block of sorted) {
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
    omissions.push(`${block.id}: omitted (token budget)`);
  }

  included.sort((a, b) => a.order - b.order);
  return { included, omissions, ledger };
}

const RESERVED_CONTENT_PRIORITIES = new Set<BriefingPriority>([
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
      used: a.ledger.used + b.ledger.used,
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

  const generalBudget = Math.max(0, tokenBudget - reservedUsed);
  const generalResult = selectBriefingBlocks(general, generalBudget);
  return mergeBlockSelections(reservedResult, generalResult);
}

function formatOmissionsLine(omissions: string[], maxBytes: number): string {
  if (omissions.length === 0) return '';
  const full = `… briefing omissions: ${omissions.join('; ')}`;
  if (estimateTextTokens(full) <= maxBytes) return full;
  const summary = omissions.length === 1
    ? `… briefing omissions: ${omissions[0]}`
    : `… briefing omissions: ${omissions.length} blocks omitted (token budget)`;
  if (estimateTextTokens(summary) <= maxBytes) return summary;
  return boundRenderedText(summary, maxBytes).text;
}

/** Shared selection + whole-response bounding for load and preview MCP surfaces. */
export function assembleBoundedBriefingText(
  blocks: BriefingBlock[],
  tokenBudget: number,
  trailingParts: string[] = [],
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
    const bounded = boundRenderedText(outLines.join('\n'), tokenBudget);
    return {
      text: bounded.text,
      omissions,
      truncated: bounded.truncated || omissions.length > 0,
    };
  }

  const omissionsReserve = Math.min(80, Math.max(0, tokenBudget - tailCost));
  const contentBudget = Math.max(0, tokenBudget - tailCost - omissionsReserve);

  const { included, omissions } = selectContentBriefingBlocks(contentBlocks, contentBudget);
  const contentLines: string[] = [];
  for (const block of included) contentLines.push(...block.lines);
  const omissionsLine = formatOmissionsLine(
    omissions,
    Math.max(0, tokenBudget - tailCost - estimateTextTokens(contentLines.join('\n'))),
  );
  if (omissionsLine) contentLines.push('', omissionsLine);

  const contentJoined = contentLines.join('\n');
  const contentLimit = Math.max(0, tokenBudget - tailCost);
  const contentEstimate = estimateTextTokens(contentJoined);
  const contentBounded = contentEstimate > contentLimit
    ? boundRenderedText(contentJoined, contentLimit)
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

export function logSectionOmission(count: number, shown: number): string {
  const hidden = count - shown;
  if (hidden <= 0) return '';
  return `… ${hidden} log ${hidden === 1 ? 'entry' : 'entries'} omitted (token budget)`;
}

export { sectionPriority, TASKS_SECTION_NAMES, LOG_SECTION_NAMES, RULES_SECTION_NAMES };
