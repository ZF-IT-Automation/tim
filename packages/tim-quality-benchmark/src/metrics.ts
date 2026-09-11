import type { EvidenceOutcome, RetrievalMetrics } from './types.js';

export function computeEvidenceOutcome(
  expected: string[],
  found: string[],
  irrelevantPool: string[] = [],
): EvidenceOutcome {
  const foundSet = new Set(found);
  const expectedSet = new Set(expected);
  const missing = expected.filter(g => !foundSet.has(g));
  const irrelevant = found.filter(g => irrelevantPool.includes(g) || (!expectedSet.has(g) && g.startsWith('gold:')));
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
    precision: precisionDenom === 0 ? (relevantFound.length === 0 ? null : 0) : relevantFound.length / precisionDenom,
    recall: recallDenom === 0 ? null : relevantFound.length / recallDenom,
    meanFirstRank: firstRanks.length === 0 ? null : firstRanks.reduce((a, b) => a + b, 0) / firstRanks.length,
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

export function extractGoldFromContext(
  context: string,
  goldLabels: string[],
): string[] {
  const found: string[] = [];
  for (const gold of goldLabels) {
    if (context.includes(gold) || context.includes(`[${gold}]`)) found.push(gold);
  }
  return found;
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
