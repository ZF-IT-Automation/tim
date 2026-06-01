import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export declare const SESSIONS_SECTION_TITLE = "Sessions";
export declare const SUMMARY_NODE_TITLE = "Summary";
export declare const EXCHANGES_NODE_TITLE = "Exchanges";
export declare const SESSIONS_SECTION_ORDER = 1000;
export declare const KIND_SESSIONS_ROOT = "sessions-root";
export declare const KIND_SESSION = "session";
export declare const KIND_SUMMARY_ROOT = "session-summary-root";
export declare const KIND_BATCH = "batch-summary";
export declare const KIND_EXCHANGES_ROOT = "exchanges-root";
export declare const KIND_EXCHANGE_BATCH = "exchange-batch";
export declare const KIND_EXCHANGE = "exchange";
export declare const SESSION_SUMMARY_TAG = "#session-summary";
export declare const DEFAULT_BATCH_SIZE = 5;
export declare const SESSION_ROLLUP_THRESHOLD = 3;
export declare const MARKER_FILENAME = ".tim-project";
export declare const MARKER_LOCK = ".tim-project.lock";
export declare const INBOX_PROJECT_LABEL = "P0000";
export interface DerivedCounters {
    exchangeCount: number;
    batchesSummarized: number;
}
/** Locate the single child of `parentId` with the given metadata.kind, or null. */
export declare function findChildByKind(store: TimStore, parentId: string, kind: string): Promise<Entry | null>;
/** Re-derive counters from the DB tree. Authoritative — never trusts caches. */
export declare function deriveCounters(store: TimStore, sessionId: string): Promise<DerivedCounters>;
/** Auto-create P0000 Inbox catch-all project if missing. */
export declare function ensureInboxProject(store: TimStore): Promise<Entry>;
//# sourceMappingURL=session-tree.d.ts.map