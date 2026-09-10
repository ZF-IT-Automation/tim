import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';
import {
  boundRenderedText,
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
    // Partial inclusion for tiny budgets: keep first line if it fits.
    const firstLine = block.lines[0];
    if (firstLine && tryChargeTokens(ledger, separator + firstLine)) {
      included.push({ ...block, lines: [firstLine] });
      if (block.lines.length > 1) {
        omissions.push(`${block.id}: ${block.lines.length - 1} lines omitted (token budget)`);
      }
      continue;
    }
    omissions.push(`${block.id}: omitted (token budget)`);
  }

  included.sort((a, b) => a.order - b.order);
  return { included, omissions, ledger };
}

/** Shared selection + whole-response bounding for load and preview MCP surfaces. */
export function assembleBoundedBriefingText(
  blocks: BriefingBlock[],
  tokenBudget: number,
  trailingParts: string[] = [],
): { text: string; omissions: string[]; truncated: boolean } {
  const { included, omissions } = selectBriefingBlocks(blocks, tokenBudget);
  const outLines: string[] = [];
  for (const block of included) outLines.push(...block.lines);
  if (omissions.length > 0) {
    outLines.push('', `… briefing omissions: ${omissions.join('; ')}`);
  }
  for (const part of trailingParts) {
    if (part) outLines.push(part);
  }
  const bounded = boundRenderedText(outLines.join('\n'), tokenBudget);
  return { text: bounded.text, omissions, truncated: bounded.truncated };
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
