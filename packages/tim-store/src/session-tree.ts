import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';

export const SESSIONS_SECTION_TITLE = 'Sessions';
export const SUMMARY_NODE_TITLE = 'Summary';
export const EXCHANGES_NODE_TITLE = 'Exchanges';
export const SESSIONS_SECTION_ORDER = 1000;

export const KIND_SESSIONS_ROOT = 'sessions-root';
export const KIND_SESSION = 'session';
export const KIND_SESSION_ALIAS = 'session-alias';
export const KIND_SUMMARY_ROOT = 'session-summary-root';
export const KIND_BATCH = 'batch-summary';
export const KIND_EXCHANGES_ROOT = 'exchanges-root';
export const KIND_EXCHANGE_BATCH = 'exchange-batch';
export const KIND_EXCHANGE = 'exchange';

export const SESSION_SUMMARY_TAG = '#session-summary';
export const BATCH_SUMMARY_TAG = '#batch-summary';

/** Structural tags on batch-summary nodes — not content hashtags. */
export const BATCH_STRUCTURAL_TAGS = new Set([SESSION_SUMMARY_TAG, BATCH_SUMMARY_TAG]);
export const DEFAULT_BATCH_SIZE = 5;
export const SESSION_ROLLUP_THRESHOLD = 3;
export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';

export const INBOX_PROJECT_LABEL = 'P0000';

export function foldBatchSummaries(batches: Pick<Entry, 'content' | 'metadata'>[]): string {
  const sorted = [...batches].sort(
    (a, b) => (Number(a.metadata.batch_index) || 0) - (Number(b.metadata.batch_index) || 0),
  );
  return sorted.map(b => b.content || '').filter(Boolean).join('\n\n---\n\n');
}

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

/** Sync variant for use inside `runExclusive` transactions. */
export function deriveCountersSync(
  store: TimStore,
  sessionId: string,
): DerivedCounters {
  const exchangesNode = store.getChildByKindSync(sessionId, KIND_EXCHANGES_ROOT)[0] ?? null;
  const summaryNode = store.getChildByKindSync(sessionId, KIND_SUMMARY_ROOT)[0] ?? null;

  let exchangeCount = 0;
  if (exchangesNode) {
    const batches = store.getChildByKindSync(exchangesNode.id, KIND_EXCHANGE_BATCH);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      const users = store.getChildrenBySeqSync(batch.id).filter(
        u => u.metadata.role === 'user',
      );
      const isLast = i === batches.length - 1;
      if (isLast && users.length === 0) continue;
      exchangeCount += users.length;
    }
  }

  let batchesSummarized = 0;
  if (summaryNode) {
    batchesSummarized = store.getChildByKindSync(summaryNode.id, KIND_BATCH).length;
  }

  return { exchangeCount, batchesSummarized };
}

const INBOX_PROJECT_TAGS = ['#project', '#inbox', '#system'] as const;

/** Create or repair the reserved P0000 Inbox project atomically. */
export async function ensureInboxProject(store: TimStore): Promise<Entry> {
  return store.runExclusive(() => {
    let existing = store.readIncludingTombstoneSync(INBOX_PROJECT_LABEL);
    if (!existing) {
      const logical = store.findByMetadataLabelIncludingTombstoneSync(INBOX_PROJECT_LABEL)
        .find(entry => entry.id !== INBOX_PROJECT_LABEL);
      if (logical) {
        existing = store.canonicalizeEntryIdSync(logical.id, INBOX_PROJECT_LABEL);
      }
    }
    if (!existing) {
      return store.writeSync('Inbox', {
        id: INBOX_PROJECT_LABEL,
        metadata: {
          kind: 'project',
          label: INBOX_PROJECT_LABEL,
          is_system: true,
          render_depth: 1,
        },
        tags: [...INBOX_PROJECT_TAGS],
      });
    }

    let title = existing.title;
    let content = existing.content;
    let metadata = { ...existing.metadata };
    const tags = new Set([...existing.tags, ...INBOX_PROJECT_TAGS]);
    let mergedDuplicate = false;

    const duplicates = store.findByMetadataLabelIncludingTombstoneSync(INBOX_PROJECT_LABEL)
      .filter(entry => entry.id !== INBOX_PROJECT_LABEL);
    for (const duplicate of duplicates) {
      const snapshots = Array.isArray(metadata.merged_inbox_entries)
        ? [...metadata.merged_inbox_entries]
        : [];
      snapshots.push({
        id: duplicate.id,
        title: duplicate.title,
        content: duplicate.content,
        metadata: duplicate.metadata,
        tags: duplicate.tags,
      });
      metadata = {
        ...duplicate.metadata,
        ...metadata,
        merged_inbox_entries: snapshots,
      };
      for (const tag of duplicate.tags) tags.add(tag);

      if (title === 'Inbox' && !content) {
        title = duplicate.title;
        content = duplicate.content;
      } else {
        const recovered = [duplicate.title, duplicate.content].filter(Boolean).join('\n');
        if (recovered) {
          content = [content, `[Recovered Inbox ${duplicate.id}]\n${recovered}`]
            .filter(Boolean)
            .join('\n\n');
        }
      }
      store.mergeEntryReferencesAndDeleteSync(duplicate.id, INBOX_PROJECT_LABEL);
      mergedDuplicate = true;
    }

    const valid =
      !mergedDuplicate &&
      existing.metadata.kind === 'project' &&
      existing.metadata.label === INBOX_PROJECT_LABEL &&
      existing.metadata.is_system === true &&
      existing.metadata.render_depth === 1 &&
      !existing.irrelevant &&
      existing.tombstonedAt === null &&
      INBOX_PROJECT_TAGS.every(tag => existing.tags.includes(tag));

    if (valid) return existing;

    return store.updateSync(existing.id, {
      title,
      content,
      irrelevant: false,
      tombstonedAt: null,
      tags: [...tags],
      metadata: {
        ...metadata,
        kind: 'project',
        label: INBOX_PROJECT_LABEL,
        is_system: true,
        render_depth: 1,
      },
    });
  });
}
