"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDeltaBriefing = getDeltaBriefing;
const DEFAULT_TIMEOUT_MS = 500;
const MAX_LINES = 5;
function formatDeltaBlock(delta) {
    const lines = [
        `[Since last session] ${delta.created.length} new, ${delta.updated.length} updated, ${delta.deleted.length} deleted`,
    ];
    const highlights = [...delta.created, ...delta.updated, ...delta.deleted]
        .slice(0, MAX_LINES - 1)
        .map(e => {
        const kind = typeof e.metadata.kind === 'string' ? e.metadata.kind : 'entry';
        const title = e.title?.trim() || kind;
        return `• ${title}`;
    });
    lines.push(...highlights);
    return lines.slice(0, MAX_LINES).join('\n');
}
async function computeDeltaBriefing(store, projectId, sessionId) {
    const projEntry = await store.read(projectId, { includeChildren: false });
    if (!projEntry || projEntry.metadata.kind !== 'project')
        return null;
    const prev = await store.getPreviousSession(projEntry.id, sessionId ?? null);
    const cutoff = prev
        ? prev.updatedAt
        : new Date(Date.now() - 7 * 86400_000).toISOString();
    const delta = await store.getChangedSince(projEntry.id, cutoff);
    const total = delta.created.length + delta.updated.length + delta.deleted.length;
    if (total === 0)
        return null;
    return formatDeltaBlock(delta);
}
/**
 * Short delta block for SessionStart briefing. Returns null when nothing
 * changed or on timeout/error — never throws.
 */
function raceWithTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        promise.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
}
async function getDeltaBriefing(store, projectId, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
        return await raceWithTimeout(computeDeltaBriefing(store, projectId, opts.sessionId), timeoutMs);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=delta.js.map