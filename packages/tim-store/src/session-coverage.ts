import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import {
  deriveCounters,
  findChildByKind,
  KIND_BATCH,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_SUMMARY_ROOT,
} from './session-tree.js';

export interface UncoveredExchange {
  seq: number;
  userId: string;
  batchIndex: number;
}

export interface CoveredRange {
  batchIndex: number;
  seqFrom: number;
  seqTo: number;
  summaryId: string;
}

export interface SessionCoverage {
  sessionId: string;
  exchangeCount: number;
  batchesSummarized: number;
  uncovered: UncoveredExchange[];
  coveredRanges: CoveredRange[];
  /** True when any exchange batch still needs summarization work. */
  hasPendingSummarization: boolean;
}

/** Same partial-batch rule as showUnsummarized: user seq above summary seq_to is uncovered. */
export async function batchHasUncoveredExchanges(
  store: TimStore,
  batchNode: Entry,
  summaryByIndex: Map<number, Entry>,
): Promise<boolean> {
  const batchIdx = Number(batchNode.metadata.batch_index);
  const summary = summaryByIndex.get(batchIdx);
  const users = (await store.getChildrenBySeq(batchNode.id)).filter(
    u => u.metadata.role === 'user',
  );
  if (users.length === 0) return false;
  if (!summary) return true;
  const maxSeq = Math.max(...users.map(u => Number(u.metadata.seq)));
  return maxSeq > Number(summary.metadata.seq_to);
}

/**
 * Authoritative session coverage from the exchange/summary tree — same semantics
 * as showUnsummarized, reusable for idle sweep and health reporting.
 */
export async function deriveSessionCoverage(
  store: TimStore,
  sessionId: string,
): Promise<SessionCoverage> {
  const { exchangeCount, batchesSummarized } = await deriveCounters(store, sessionId);

  const exNode = await findChildByKind(store, sessionId, KIND_EXCHANGES_ROOT);
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);

  const uncovered: UncoveredExchange[] = [];
  const coveredRanges: CoveredRange[] = [];

  if (!exNode) {
    return {
      sessionId,
      exchangeCount,
      batchesSummarized,
      uncovered,
      coveredRanges,
      hasPendingSummarization: false,
    };
  }

  const exchangeBatches = (await store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH))
    .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index));

  const summaryBatches = summaryNode
    ? await store.getChildByKind(summaryNode.id, KIND_BATCH)
    : [];
  const summaryByIndex = new Map(
    summaryBatches.map(s => [Number(s.metadata.batch_index), s]),
  );

  for (const batchNode of exchangeBatches) {
    const batchIdx = Number(batchNode.metadata.batch_index);
    const summary = summaryByIndex.get(batchIdx);
    const users = (await store.getChildrenBySeq(batchNode.id)).filter(
      u => u.metadata.role === 'user',
    );
    if (users.length === 0) continue;

    if (summary) {
      coveredRanges.push({
        batchIndex: batchIdx,
        seqFrom: Number(summary.metadata.seq_from),
        seqTo: Number(summary.metadata.seq_to),
        summaryId: summary.id,
      });
    }

    const hasUncovered = await batchHasUncoveredExchanges(store, batchNode, summaryByIndex);
    if (!hasUncovered) continue;

    const seqFloor = summary ? Number(summary.metadata.seq_to) : 0;
    for (const u of users) {
      const seq = Number(u.metadata.seq);
      if (seq > seqFloor) {
        uncovered.push({ seq, userId: u.id, batchIndex: batchIdx });
      }
    }
  }

  return {
    sessionId,
    exchangeCount,
    batchesSummarized,
    uncovered,
    coveredRanges,
    hasPendingSummarization: uncovered.length > 0,
  };
}
