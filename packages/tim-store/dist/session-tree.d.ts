import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export declare const SESSIONS_SECTION_TITLE = "Sessions";
export declare const SUMMARY_NODE_TITLE = "Summary";
export declare const EXCHANGES_NODE_TITLE = "Exchanges";
export declare const SESSIONS_SECTION_ORDER = 1000;
export declare const KIND_SESSIONS_ROOT = "sessions-root";
export declare const KIND_SESSION = "session";
export declare const KIND_SESSION_ALIAS = "session-alias";
export declare const KIND_SUMMARY_ROOT = "session-summary-root";
export declare const KIND_BATCH = "batch-summary";
export declare const KIND_EXCHANGES_ROOT = "exchanges-root";
export declare const KIND_EXCHANGE_BATCH = "exchange-batch";
export declare const KIND_EXCHANGE = "exchange";
export declare const SESSION_SUMMARY_TAG = "#session-summary";
export declare const BATCH_SUMMARY_TAG = "#batch-summary";
/** Structural tags on batch-summary nodes — not content hashtags. */
export declare const BATCH_STRUCTURAL_TAGS: Set<string>;
export declare const DEFAULT_BATCH_SIZE = 5;
export declare const SESSION_ROLLUP_THRESHOLD = 3;
export declare const MARKER_FILENAME = ".tim-project";
export declare const INBOX_PROJECT_LABEL = "P0000";
export declare function foldBatchSummaries(batches: Pick<Entry, 'content' | 'metadata'>[]): string;
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
export declare function getCurrentBatch(store: TimStore, exchangesNodeId: string): Promise<CurrentBatch>;
/** Locate the single child of `parentId` with the given metadata.kind, or null. */
export declare function findChildByKind(store: TimStore, parentId: string, kind: string): Promise<Entry | null>;
/**
 * Find a project's managed root (`sessions-root`, `commits-root`), un-hiding it if
 * it was flagged irrelevant.
 *
 * Deliberately looks past the `irrelevant = 0` filter every other lookup applies. A
 * structural root is not content: when a migration or a bad bulk update flags a
 * project's children invisible, a filtered lookup misses the root that exists and
 * its caller creates a second one. Repairing the flag afterwards leaves both behind
 * — which is how P0063 collected three "Commits" and two "Sessions" roots on
 * 2026-06-03, the day its whole tree was flagged irrelevant. Callers that create the
 * root when the lookup returns null must use this, not `findChildByKind`.
 */
export declare function findManagedRoot(store: TimStore, projectId: string, kind: string): Promise<Entry | null>;
/** Re-derive counters from the DB tree. Authoritative — never trusts caches. */
export declare function deriveCounters(store: TimStore, sessionId: string): Promise<DerivedCounters>;
/** Sync variant for use inside `runExclusive` transactions. */
export declare function deriveCountersSync(store: TimStore, sessionId: string): DerivedCounters;
/** Create or repair the reserved P0000 Inbox project atomically. */
export declare function ensureInboxProject(store: TimStore): Promise<Entry>;
//# sourceMappingURL=session-tree.d.ts.map