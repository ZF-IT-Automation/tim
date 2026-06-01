"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INBOX_PROJECT_LABEL = exports.MARKER_LOCK = exports.MARKER_FILENAME = exports.SESSION_ROLLUP_THRESHOLD = exports.DEFAULT_BATCH_SIZE = exports.SESSION_SUMMARY_TAG = exports.KIND_EXCHANGE = exports.KIND_EXCHANGE_BATCH = exports.KIND_EXCHANGES_ROOT = exports.KIND_BATCH = exports.KIND_SUMMARY_ROOT = exports.KIND_SESSION = exports.KIND_SESSIONS_ROOT = exports.SESSIONS_SECTION_ORDER = exports.EXCHANGES_NODE_TITLE = exports.SUMMARY_NODE_TITLE = exports.SESSIONS_SECTION_TITLE = void 0;
exports.findChildByKind = findChildByKind;
exports.deriveCounters = deriveCounters;
exports.ensureInboxProject = ensureInboxProject;
exports.SESSIONS_SECTION_TITLE = 'Sessions';
exports.SUMMARY_NODE_TITLE = 'Summary';
exports.EXCHANGES_NODE_TITLE = 'Exchanges';
exports.SESSIONS_SECTION_ORDER = 1000;
exports.KIND_SESSIONS_ROOT = 'sessions-root';
exports.KIND_SESSION = 'session';
exports.KIND_SUMMARY_ROOT = 'session-summary-root';
exports.KIND_BATCH = 'batch-summary';
exports.KIND_EXCHANGES_ROOT = 'exchanges-root';
exports.KIND_EXCHANGE_BATCH = 'exchange-batch';
exports.KIND_EXCHANGE = 'exchange';
exports.SESSION_SUMMARY_TAG = '#session-summary';
exports.DEFAULT_BATCH_SIZE = 5;
exports.SESSION_ROLLUP_THRESHOLD = 3;
exports.MARKER_FILENAME = '.tim-project';
exports.MARKER_LOCK = '.tim-project.lock';
exports.INBOX_PROJECT_LABEL = 'P0000';
/** Locate the single child of `parentId` with the given metadata.kind, or null. */
async function findChildByKind(store, parentId, kind) {
    const kids = await store.getChildByKind(parentId, kind);
    return kids[0] ?? null;
}
/** Re-derive counters from the DB tree. Authoritative — never trusts caches. */
async function deriveCounters(store, sessionId) {
    const exchangesNode = await findChildByKind(store, sessionId, exports.KIND_EXCHANGES_ROOT);
    const summaryNode = await findChildByKind(store, sessionId, exports.KIND_SUMMARY_ROOT);
    let exchangeCount = 0;
    if (exchangesNode) {
        const batches = await store.getChildByKind(exchangesNode.id, exports.KIND_EXCHANGE_BATCH);
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const users = (await store.getChildrenBySeq(batch.id)).filter(u => u.metadata.role === 'user');
            const isLast = i === batches.length - 1;
            if (isLast && users.length === 0)
                continue;
            exchangeCount += users.length;
        }
    }
    let batchesSummarized = 0;
    if (summaryNode) {
        const batches = await store.getChildByKind(summaryNode.id, exports.KIND_BATCH);
        batchesSummarized = batches.length;
    }
    return { exchangeCount, batchesSummarized };
}
/** Auto-create P0000 Inbox catch-all project if missing. */
async function ensureInboxProject(store) {
    const existing = await store.read(exports.INBOX_PROJECT_LABEL);
    if (existing?.metadata.kind === 'project')
        return existing;
    return store.write('Inbox', {
        id: exports.INBOX_PROJECT_LABEL,
        metadata: {
            kind: 'project',
            label: exports.INBOX_PROJECT_LABEL,
            is_system: true,
            render_depth: 1,
        },
        tags: ['#project', '#inbox', '#system'],
    });
}
//# sourceMappingURL=session-tree.js.map