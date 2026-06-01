import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';

export const SESSIONS_SECTION_TITLE = 'Sessions';
export const SUMMARY_NODE_TITLE = 'Summary';
export const EXCHANGES_NODE_TITLE = 'Exchanges';
export const SESSIONS_SECTION_ORDER = 1000;

export const KIND_SESSIONS_ROOT = 'sessions-root';
export const KIND_SESSION = 'session';
export const KIND_SUMMARY_ROOT = 'session-summary-root';
export const KIND_BATCH = 'batch-summary';
export const KIND_EXCHANGES_ROOT = 'exchanges-root';
export const KIND_EXCHANGE_BATCH = 'exchange-batch';
export const KIND_EXCHANGE = 'exchange';

export const SESSION_SUMMARY_TAG = '#session-summary';
export const DEFAULT_BATCH_SIZE = 5;
export const SESSION_ROLLUP_THRESHOLD = 3;
export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';

export const INBOX_PROJECT_LABEL = 'P0000';

export interface DerivedCounters {
  exchangeCount: number;
  batchesSummarized: number;
}

export interface CurrentBatch {
  batchNode: Entry;
  usersInBatch: Entry[];
  allBatches: Entry[];
}

/** Latest exchange-batch under Exchanges; creates Batch 1 if missing. */
export async function getCurrentBatch(
  store: TimStore,
  exchangesNodeId: string,
): Promise<CurrentBatch> {
  const allBatches = await store.getChildByKind(exchangesNodeId, KIND_EXCHANGE_BATCH);
  let batchNode = allBatches[allBatches.length - 1] ?? null;
  if (!batchNode) {
    batchNode = await store.write('Batch 1', {
      parentId: exchangesNodeId,
      metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: 1, order: 1 },
    });
    allBatches.push(batchNode);
  }
  const usersInBatch = (await store.getChildrenBySeq(batchNode.id)).filter(
    u => u.metadata.role === 'user',
  );
  return { batchNode, usersInBatch, allBatches };
}

/** Locate the single child of `parentId` with the given metadata.kind, or null. */
export async function findChildByKind(
  store: TimStore,
  parentId: string,
  kind: string,
): Promise<Entry | null> {
  const kids = await store.getChildByKind(parentId, kind);
  return kids[0] ?? null;
}

/** Re-derive counters from the DB tree. Authoritative — never trusts caches. */
export async function deriveCounters(
  store: TimStore,
  sessionId: string,
): Promise<DerivedCounters> {
  const exchangesNode = await findChildByKind(store, sessionId, KIND_EXCHANGES_ROOT);
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);

  let exchangeCount = 0;
  if (exchangesNode) {
    const batches = await store.getChildByKind(exchangesNode.id, KIND_EXCHANGE_BATCH);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const users = (await store.getChildrenBySeq(batch.id)).filter(
        u => u.metadata.role === 'user',
      );
      const isLast = i === batches.length - 1;
      if (isLast && users.length === 0) continue;
      exchangeCount += users.length;
    }
  }

  let batchesSummarized = 0;
  if (summaryNode) {
    const batches = await store.getChildByKind(summaryNode.id, KIND_BATCH);
    batchesSummarized = batches.length;
  }

  return { exchangeCount, batchesSummarized };
}

/** Auto-create P0000 Inbox catch-all project if missing. */
export async function ensureInboxProject(store: TimStore): Promise<Entry> {
  const existing = await store.read(INBOX_PROJECT_LABEL);
  if (existing?.metadata.kind === 'project') return existing;

  return store.write('Inbox', {
    id: INBOX_PROJECT_LABEL,
    metadata: {
      kind: 'project',
      label: INBOX_PROJECT_LABEL,
      is_system: true,
      render_depth: 1,
    },
    tags: ['#project', '#inbox', '#system'],
  });
}
