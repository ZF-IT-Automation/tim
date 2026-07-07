"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rebalanceBatch = rebalanceBatch;
const tim_store_1 = require("tim-store");
const marker_js_1 = require("./marker.js");
const STOP_WORDS = new Set([
    'about', 'after', 'also', 'been', 'from', 'have', 'into', 'just', 'more', 'some',
    'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
    'those', 'very', 'what', 'when', 'which', 'with', 'your',
]);
function exchangeSummaryText(entry) {
    return `${entry.title} ${entry.content}`.trim();
}
function keywords(text) {
    const out = new Set();
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length >= 4 && !STOP_WORDS.has(raw))
            out.add(raw);
    }
    return out;
}
function shareKeywords(a, b) {
    const ka = keywords(exchangeSummaryText(a));
    const kb = keywords(exchangeSummaryText(b));
    for (const k of ka) {
        if (kb.has(k))
            return true;
    }
    return false;
}
async function userExchanges(store, batchId) {
    return (await store.getChildrenBySeq(batchId)).filter(u => u.metadata.role === 'user');
}
async function agentReply(store, user) {
    const replies = await store.getChildren(user.id);
    return replies.find(r => r.metadata.role === 'agent') ?? null;
}
/**
 * Scan exchange-batch boundaries; move the first exchange of batch N (+ agent reply)
 * into batch N-1 when it is topically related to the last exchange of N-1.
 */
async function rebalanceBatch(store, sessionId, opts = {}) {
    const skipped = [];
    let resolvedCwd = opts.cwd;
    if (!resolvedCwd) {
        const session = await store.read(sessionId);
        if (typeof session?.metadata.cwd === 'string')
            resolvedCwd = session.metadata.cwd;
    }
    if (resolvedCwd && (0, marker_js_1.isSessionLocked)(resolvedCwd)) {
        return { moved: 0, skipped: [{ reason: 'locked' }] };
    }
    const session = await store.read(sessionId);
    if (!session || session.metadata.kind !== 'session') {
        throw new Error(`Session not found: ${sessionId}`);
    }
    const exNode = await (0, tim_store_1.findChildByKind)(store, sessionId, tim_store_1.KIND_EXCHANGES_ROOT);
    if (!exNode)
        return { moved: 0, skipped };
    const batches = await store.getChildByKind(exNode.id, tim_store_1.KIND_EXCHANGE_BATCH);
    if (batches.length < 2) {
        return { moved: 0, skipped: [{ reason: 'no-boundary' }] };
    }
    let moved = 0;
    for (let i = 1; i < batches.length; i++) {
        const prev = batches[i - 1];
        const curr = batches[i];
        const batchIndex = typeof curr.metadata.batch_index === 'number' ? curr.metadata.batch_index : i + 1;
        const prevUsers = await userExchanges(store, prev.id);
        const currUsers = await userExchanges(store, curr.id);
        if (currUsers.length < 2) {
            skipped.push({ reason: 'single-exchange-batch', batchIndex });
            continue;
        }
        const lastPrev = prevUsers[prevUsers.length - 1];
        const firstCurr = currUsers[0];
        if (!lastPrev || !firstCurr)
            continue;
        if (!shareKeywords(lastPrev, firstCurr)) {
            skipped.push({ reason: 'unrelated', batchIndex });
            continue;
        }
        const agent = await agentReply(store, firstCurr);
        store.curate().moveEntry(firstCurr.id, prev.id);
        if (agent)
            store.curate().moveEntry(agent.id, prev.id);
        moved += 1;
    }
    return { moved, skipped };
}
//# sourceMappingURL=rebalance.js.map