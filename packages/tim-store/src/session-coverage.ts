import { parseEvidenceMetadata } from 'tim-core';
import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { isCountableUserExchange } from './harness-prompt.js';
import {
  deriveCounters,
  findChildByKind,
  KIND_BATCH,
  KIND_EXCHANGE,
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
  /** User exchanges whose seq metadata is missing or not a positive integer. */
  unknownSequenceExchangeCount: number;
}

function isValidUserSeq(seq: unknown): seq is number {
  return typeof seq === 'number' && Number.isFinite(seq) && seq > 0 && Number.isInteger(seq);
}

function sessionEvidenceRange(
  metadata: Record<string, unknown>,
  sessionId: string,
): { seqFrom: number; seqTo: number } | null {
  const evidence = parseEvidenceMetadata(metadata.evidence);
  if (!evidence) return null;
  const source = evidence.sources.find(
    s => s.kind === 'session' && s.sessionId === sessionId,
  );
  if (!source || source.kind !== 'session') return null;
  const seqFrom = Number(source.seqFrom);
  const seqTo = Number(source.seqTo);
  if (!Number.isFinite(seqFrom) || !Number.isFinite(seqTo) || seqFrom > seqTo) return null;
  return { seqFrom, seqTo };
}

/** User exchanges not covered by a batch summary interval (once per batch). */
export function uncoveredUserSeqs(users: Entry[], summary?: Entry): number[] {
  const userSeqs = users
    .filter(u => u.metadata.role === 'user' && isCountableUserExchange(u))
    .map(u => Number(u.metadata.seq))
    .filter(n => isValidUserSeq(n))
    .sort((a, b) => a - b);
  if (userSeqs.length === 0) return [];
  if (!summary) return userSeqs;

  const seqFrom = Number(summary.metadata.seq_from);
  const seqTo = Number(summary.metadata.seq_to);
  if (!Number.isFinite(seqFrom) || !Number.isFinite(seqTo) || seqFrom > seqTo) {
    return userSeqs;
  }

  // Inspect observed exchanges, never expand a potentially huge imported range.
  return userSeqs.filter(seq => seq < seqFrom || seq > seqTo);
}

/** Same partial-batch rule as showUnsummarized, reusable for idle sweep and health reporting. */
export function batchHasUncoveredExchanges(users: Entry[], summary?: Entry): boolean {
  return uncoveredUserSeqs(users, summary).length > 0;
}

async function findFlatCoverageEvidence(
  store: TimStore,
  sessionId: string,
  summaryNode: Entry | null,
): Promise<{ seqFrom: number; seqTo: number; summaryId: string } | null> {
  if (!summaryNode) return null;

  const rootText = typeof summaryNode.metadata.summary === 'string'
    ? summaryNode.metadata.summary.trim()
    : '';
  const rootRange = sessionEvidenceRange(summaryNode.metadata, sessionId);
  if (rootRange && rootText.length > 0) {
    return { ...rootRange, summaryId: summaryNode.id };
  }

  const children = await store.getChildren(summaryNode.id);
  let best: { seqFrom: number; seqTo: number; summaryId: string; updatedAt: string } | null = null;
  for (const child of children) {
    const kind = child.metadata.kind;
    if (kind !== 'checkpoint' && kind !== KIND_BATCH) continue;
    const body = `${child.content ?? ''}\n${child.title ?? ''}`.trim();
    if (!body) continue;
    const range = sessionEvidenceRange(child.metadata, sessionId);
    if (!range) continue;
    const updatedAt = child.updatedAt || child.createdAt;
    if (!best || updatedAt.localeCompare(best.updatedAt) > 0) {
      best = { ...range, summaryId: child.id, updatedAt };
    }
  }
  return best;
}

async function deriveFlatSessionCoverage(
  store: TimStore,
  sessionId: string,
  batchesSummarized: number,
): Promise<SessionCoverage> {
  const users = (await store.getChildren(sessionId, { metadataKind: KIND_EXCHANGE }))
    .filter(u => u.metadata.role === 'user');

  const uncovered: UncoveredExchange[] = [];
  const coveredRanges: CoveredRange[] = [];
  let unknownSequenceExchangeCount = 0;
  const validUsers: Entry[] = [];

  for (const user of users) {
    if (!isCountableUserExchange(user)) continue;
    const seq = Number(user.metadata.seq);
    if (isValidUserSeq(seq)) {
      validUsers.push(user);
    } else {
      unknownSequenceExchangeCount++;
      uncovered.push({ seq: Number.isFinite(seq) ? seq : 0, userId: user.id, batchIndex: 0 });
    }
  }

  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  const evidence = await findFlatCoverageEvidence(store, sessionId, summaryNode);
  if (evidence) {
    coveredRanges.push({
      batchIndex: 0,
      seqFrom: evidence.seqFrom,
      seqTo: evidence.seqTo,
      summaryId: evidence.summaryId,
    });
    for (const user of validUsers) {
      const seq = Number(user.metadata.seq);
      if (seq < evidence.seqFrom || seq > evidence.seqTo) {
        uncovered.push({ seq, userId: user.id, batchIndex: 0 });
      }
    }
  } else {
    for (const user of validUsers) {
      uncovered.push({
        seq: Number(user.metadata.seq),
        userId: user.id,
        batchIndex: 0,
      });
    }
  }

  return {
    sessionId,
    exchangeCount: users.length,
    batchesSummarized,
    uncovered,
    coveredRanges,
    hasPendingSummarization: uncovered.length > 0,
    unknownSequenceExchangeCount,
  };
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
  if (!exNode) {
    const flat = await deriveFlatSessionCoverage(store, sessionId, batchesSummarized);
    if (flat.exchangeCount > 0 || exchangeCount === 0) return flat;
    return {
      ...flat,
      exchangeCount,
    };
  }

  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);

  const uncovered: UncoveredExchange[] = [];
  const coveredRanges: CoveredRange[] = [];
  let unknownSequenceExchangeCount = 0;

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
    const countableUsers = users.filter(isCountableUserExchange);
    if (countableUsers.length === 0) continue;

    if (summary) {
      coveredRanges.push({
        batchIndex: batchIdx,
        seqFrom: Number(summary.metadata.seq_from),
        seqTo: Number(summary.metadata.seq_to),
        summaryId: summary.id,
      });
    }

    const validUsers = countableUsers.filter(u => isValidUserSeq(Number(u.metadata.seq)));
    unknownSequenceExchangeCount += countableUsers.length - validUsers.length;
    for (const user of countableUsers) {
      const seq = Number(user.metadata.seq);
      if (!isValidUserSeq(seq)) {
        uncovered.push({ seq: Number.isFinite(seq) ? seq : 0, userId: user.id, batchIndex: batchIdx });
      }
    }

    const missingSeqs = uncoveredUserSeqs(validUsers, summary);
    if (missingSeqs.length === 0) continue;

    const userBySeq = new Map(validUsers.map(u => [Number(u.metadata.seq), u]));
    for (const seq of missingSeqs) {
      const u = userBySeq.get(seq);
      if (u) uncovered.push({ seq, userId: u.id, batchIndex: batchIdx });
    }
  }

  return {
    sessionId,
    exchangeCount,
    batchesSummarized,
    uncovered,
    coveredRanges,
    hasPendingSummarization: uncovered.length > 0,
    unknownSequenceExchangeCount,
  };
}
