"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INBOX_PROJECT_LABEL = exports.MARKER_LOCK = exports.MARKER_FILENAME = exports.SESSION_ROLLUP_THRESHOLD = exports.DEFAULT_BATCH_SIZE = exports.BATCH_STRUCTURAL_TAGS = exports.BATCH_SUMMARY_TAG = exports.SESSION_SUMMARY_TAG = exports.KIND_EXCHANGE = exports.KIND_EXCHANGE_BATCH = exports.KIND_EXCHANGES_ROOT = exports.KIND_BATCH = exports.KIND_SUMMARY_ROOT = exports.KIND_SESSION_ALIAS = exports.KIND_SESSION = exports.KIND_SESSIONS_ROOT = exports.SESSIONS_SECTION_ORDER = exports.EXCHANGES_NODE_TITLE = exports.SUMMARY_NODE_TITLE = exports.SESSIONS_SECTION_TITLE = void 0;
exports.foldBatchSummaries = foldBatchSummaries;
exports.getCurrentBatch = getCurrentBatch;
exports.findChildByKind = findChildByKind;
exports.deriveCounters = deriveCounters;
exports.deriveCountersSync = deriveCountersSync;
exports.ensureInboxProject = ensureInboxProject;
exports.SESSIONS_SECTION_TITLE = 'Sessions';
exports.SUMMARY_NODE_TITLE = 'Summary';
exports.EXCHANGES_NODE_TITLE = 'Exchanges';
exports.SESSIONS_SECTION_ORDER = 1000;
exports.KIND_SESSIONS_ROOT = 'sessions-root';
exports.KIND_SESSION = 'session';
exports.KIND_SESSION_ALIAS = 'session-alias';
exports.KIND_SUMMARY_ROOT = 'session-summary-root';
exports.KIND_BATCH = 'batch-summary';
exports.KIND_EXCHANGES_ROOT = 'exchanges-root';
exports.KIND_EXCHANGE_BATCH = 'exchange-batch';
exports.KIND_EXCHANGE = 'exchange';
exports.SESSION_SUMMARY_TAG = '#session-summary';
exports.BATCH_SUMMARY_TAG = '#batch-summary';
/** Structural tags on batch-summary nodes — not content hashtags. */
exports.BATCH_STRUCTURAL_TAGS = new Set([exports.SESSION_SUMMARY_TAG, exports.BATCH_SUMMARY_TAG]);
exports.DEFAULT_BATCH_SIZE = 5;
exports.SESSION_ROLLUP_THRESHOLD = 3;
exports.MARKER_FILENAME = '.tim-project';
exports.MARKER_LOCK = '.tim-project.lock';
exports.INBOX_PROJECT_LABEL = 'P0000';
function foldBatchSummaries(batches) {
    const sorted = [...batches].sort((a, b) => (Number(a.metadata.batch_index) || 0) - (Number(b.metadata.batch_index) || 0));
    return sorted.map(b => b.content || '').filter(Boolean).join('\n\n---\n\n');
}
/** Latest exchange-batch under Exchanges; creates Batch 1 if missing. */
async function getCurrentBatch(store, exchangesNodeId) {
    const allBatches = await store.getChildByKind(exchangesNodeId, exports.KIND_EXCHANGE_BATCH);
    let batchNode = allBatches[allBatches.length - 1] ?? null;
    if (!batchNode) {
        batchNode = await store.write('Batch 1', {
            parentId: exchangesNodeId,
            metadata: { kind: exports.KIND_EXCHANGE_BATCH, batch_index: 1, order: 1 },
        });
        allBatches.push(batchNode);
    }
    const usersInBatch = (await store.getChildrenBySeq(batchNode.id)).filter(u => u.metadata.role === 'user');
    return { batchNode, usersInBatch, allBatches };
}
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
/** Sync variant for use inside `runExclusive` transactions. */
function deriveCountersSync(store, sessionId) {
    const exchangesNode = store.getChildByKindSync(sessionId, exports.KIND_EXCHANGES_ROOT)[0] ?? null;
    const summaryNode = store.getChildByKindSync(sessionId, exports.KIND_SUMMARY_ROOT)[0] ?? null;
    let exchangeCount = 0;
    if (exchangesNode) {
        const batches = store.getChildByKindSync(exchangesNode.id, exports.KIND_EXCHANGE_BATCH);
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const users = store.getChildrenBySeqSync(batch.id).filter(u => u.metadata.role === 'user');
            const isLast = i === batches.length - 1;
            if (isLast && users.length === 0)
                continue;
            exchangeCount += users.length;
        }
    }
    let batchesSummarized = 0;
    if (summaryNode) {
        batchesSummarized = store.getChildByKindSync(summaryNode.id, exports.KIND_BATCH).length;
    }
    return { exchangeCount, batchesSummarized };
}
const INBOX_PROJECT_TAGS = ['#project', '#inbox', '#system'];
/** Create or repair the reserved P0000 Inbox project atomically. */
async function ensureInboxProject(store) {
    return store.runExclusive(() => {
        const rewrites = [];
        let existing = store.readSystemRepairEntrySync(exports.INBOX_PROJECT_LABEL);
        if (!existing) {
            const logical = store.findSystemRepairEntriesByLabelSync(exports.INBOX_PROJECT_LABEL)
                .find(entry => entry.id !== exports.INBOX_PROJECT_LABEL);
            if (logical) {
                const canonicalized = store.canonicalizeEntryIdSync(logical.id, exports.INBOX_PROJECT_LABEL);
                existing = canonicalized.entry;
                if (canonicalized.rewrite)
                    rewrites.push(canonicalized.rewrite);
            }
        }
        if (!existing) {
            return store.writeSync('Inbox', {
                id: exports.INBOX_PROJECT_LABEL,
                metadata: {
                    kind: 'project',
                    label: exports.INBOX_PROJECT_LABEL,
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
        const duplicates = store.findSystemRepairEntriesByLabelSync(exports.INBOX_PROJECT_LABEL)
            .filter(entry => entry.id !== exports.INBOX_PROJECT_LABEL);
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
            const rewrittenDuplicateMetadata = store.rewriteSystemRepairMetadataReferences(duplicate.metadata, duplicate.id, exports.INBOX_PROJECT_LABEL);
            metadata = {
                ...rewrittenDuplicateMetadata,
                ...metadata,
                merged_inbox_entries: snapshots,
            };
            for (const tag of duplicate.tags)
                tags.add(tag);
            if (title === 'Inbox' && !content) {
                title = duplicate.title;
                content = duplicate.content;
            }
            else {
                const recovered = [duplicate.title, duplicate.content].filter(Boolean).join('\n');
                if (recovered) {
                    content = [content, `[Recovered Inbox ${duplicate.id}]\n${recovered}`]
                        .filter(Boolean)
                        .join('\n\n');
                }
            }
            const rewrite = store.mergeEntryReferencesAndDeleteSync(duplicate.id, exports.INBOX_PROJECT_LABEL);
            if (rewrite)
                rewrites.push(rewrite);
            const postRewriteCanonical = store.readSystemRepairEntrySync(exports.INBOX_PROJECT_LABEL);
            if (!postRewriteCanonical)
                throw new Error('Inbox canonical row disappeared during repair');
            metadata = {
                ...metadata,
                ...postRewriteCanonical.metadata,
                merged_inbox_entries: snapshots,
            };
            mergedDuplicate = true;
        }
        const valid = !mergedDuplicate &&
            rewrites.length === 0 &&
            existing.metadata.kind === 'project' &&
            existing.metadata.label === exports.INBOX_PROJECT_LABEL &&
            existing.metadata.is_system === true &&
            existing.metadata.render_depth === 1 &&
            !existing.irrelevant &&
            existing.tombstonedAt === null &&
            INBOX_PROJECT_TAGS.every(tag => existing.tags.includes(tag));
        if (valid)
            return existing;
        const repaired = store.repairSystemEntrySync(existing.id, {
            title,
            content,
            irrelevant: false,
            tombstonedAt: null,
            tags: [...tags],
            metadata: {
                ...metadata,
                kind: 'project',
                label: exports.INBOX_PROJECT_LABEL,
                is_system: true,
                render_depth: 1,
            },
        });
        store.stageEntryIdRewritesSync(exports.INBOX_PROJECT_LABEL, rewrites);
        return repaired;
    });
}
//# sourceMappingURL=session-tree.js.map