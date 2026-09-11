import { boundRenderedText } from 'tim-mcp/dist/briefing-budget.js';
import type { EvidenceOutcome, RetrievalMetrics } from './types.js';

/** Marker for retrieved entries without a gold label — counts in precision denominator. */
export const NON_GOLD_MARKER_PREFIX = 'retrieved:';

export function applyContextByteBudget(context: string, byteBudget: number): string {
  return boundRenderedText(context, byteBudget).text;
}

export function assembleBoundedContext(parts: string[], byteBudget: number): string {
  let assembled = '';
  for (const part of parts) {
    const candidate = assembled ? `${assembled}\n---\n${part}` : part;
    if (Buffer.byteLength(candidate, 'utf8') <= byteBudget) {
      assembled = candidate;
    } else {
      break;
    }
  }
  return applyContextByteBudget(assembled, byteBudget);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract gold labels from context in appearance order.
 * Bracket markers `[gold:…]` are preferred; bare labels require boundary guards
 * so `gold:decision-v1` does not match inside `gold:decision-current`.
 */
export function extractGoldFromContextInOrder(
  context: string,
  goldLabels: string[],
): string[] {
  const goldSet = new Set(goldLabels);
  const matches: Array<{ pos: number; label: string }> = [];

  const bracketRe = /\[((?:gold:[a-z0-9-]+))\]/g;
  let bracketMatch: RegExpExecArray | null;
  while ((bracketMatch = bracketRe.exec(context)) !== null) {
    const label = bracketMatch[1];
    if (goldSet.has(label)) {
      matches.push({ pos: bracketMatch.index, label });
    }
  }

  const sortedByLength = [...goldLabels].sort((a, b) => b.length - a.length);
  for (const gold of sortedByLength) {
    const bareRe = new RegExp(`(?<![\\w:[\\]])${escapeRegExp(gold)}(?![\\w-])`, 'g');
    let bareMatch: RegExpExecArray | null;
    while ((bareMatch = bareRe.exec(context)) !== null) {
      const overlapsBracket = matches.some(
        m => bareMatch!.index >= m.pos && bareMatch!.index < m.pos + m.label.length + 2,
      );
      if (!overlapsBracket) {
        matches.push({ pos: bareMatch.index, label: gold });
      }
    }
  }

  matches.sort((a, b) => a.pos - b.pos);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const { label } of matches) {
    if (!seen.has(label)) {
      seen.add(label);
      ordered.push(label);
    }
  }
  return ordered;
}

/** @deprecated Use extractGoldFromContextInOrder */
export function extractGoldFromContext(context: string, goldLabels: string[]): string[] {
  return extractGoldFromContextInOrder(context, goldLabels);
}

export function mapEntryIdsToGold(
  entryIds: string[],
  entryIdToGold: Map<string, string>,
): string[] {
  const out: string[] = [];
  for (const id of entryIds) {
    const gold = entryIdToGold.get(id);
    if (gold) out.push(gold);
  }
  return out;
}

/** Map search hits to ordered evidence markers, retaining non-gold hits for precision. */
export function mapEntriesToOrderedEvidence(
  entryIds: string[],
  entryIdToGold: Map<string, string>,
): string[] {
  return entryIds.map(id => entryIdToGold.get(id) ?? `${NON_GOLD_MARKER_PREFIX}${id}`);
}

export function computeEvidenceOutcome(
  expected: string[],
  found: string[],
  irrelevantPool: string[] = [],
): EvidenceOutcome {
  const foundSet = new Set(found);
  const expectedSet = new Set(expected);
  const missing = expected.filter(g => !foundSet.has(g));
  const irrelevant = found.filter(
    g =>
      irrelevantPool.includes(g)
      || (!expectedSet.has(g)
        && (g.startsWith('gold:') || g.startsWith(NON_GOLD_MARKER_PREFIX))),
  );
  const relevantFound = found.filter(g => expectedSet.has(g));
  return {
    expected: [...expected],
    found: relevantFound,
    missing,
    irrelevant,
  };
}

export function computeRetrievalMetrics(
  expected: string[],
  orderedFound: string[],
): RetrievalMetrics {
  const ranks: Record<string, number | null> = {};
  const firstRanks: number[] = [];

  for (const gold of expected) {
    const idx = orderedFound.indexOf(gold);
    const rank = idx >= 0 ? idx + 1 : null;
    ranks[gold] = rank;
    if (rank !== null) firstRanks.push(rank);
  }

  const relevantFound = expected.filter(g => orderedFound.includes(g));
  const precisionDenom = orderedFound.length;
  const recallDenom = expected.length;

  return {
    precision:
      precisionDenom === 0
        ? relevantFound.length === 0
          ? null
          : 0
        : relevantFound.length / precisionDenom,
    recall: recallDenom === 0 ? null : relevantFound.length / recallDenom,
    meanFirstRank:
      firstRanks.length === 0
        ? null
        : firstRanks.reduce((a, b) => a + b, 0) / firstRanks.length,
    ranks,
  };
}

export function macroAverage(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function estimateTokensFromBytes(bytes: number): number {
  return bytes;
}

export function computeBaselineObservations(
  questionResults: Array<{
    id: string;
    timRecall: number | null;
    handoffRecall: number | null;
    noMemoryRecall: number | null;
  }>,
): string[] {
  const observations: string[] = [];
  for (const q of questionResults) {
    if (q.noMemoryRecall === 0 || q.noMemoryRecall === null) {
      observations.push(`${q.id}: no-memory finds no expected evidence (by design).`);
    }
    if (q.timRecall !== null && q.handoffRecall !== null && q.timRecall > q.handoffRecall) {
      observations.push(
        `${q.id}: tim recall (${q.timRecall.toFixed(2)}) exceeds fixed-handoff (${q.handoffRecall.toFixed(2)}).`,
      );
    } else if (q.timRecall !== null && q.handoffRecall !== null && q.timRecall < q.handoffRecall) {
      observations.push(
        `${q.id}: fixed-handoff recall (${q.handoffRecall.toFixed(2)}) exceeds tim (${q.timRecall.toFixed(2)}) on this fixture.`,
      );
    }
  }
  if (observations.length === 0) {
    observations.push('No mode exceeded another on recall across all questions in this run.');
  }
  return observations;
}
