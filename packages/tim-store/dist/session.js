"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
exports.assertSessionId = assertSessionId;
exports.exchangeText = exchangeText;
exports.resolveCurrentSession = resolveCurrentSession;
exports.ensureProjectForPath = ensureProjectForPath;
const tim_core_1 = require("tim-core");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const session_tree_js_1 = require("./session-tree.js");
const project_schema_init_js_1 = require("./project-schema-init.js");
/**
 * A session node is keyed by its id, so a blank one produces an unaddressable
 * node that no turn-end hook can ever find again — the database already holds
 * one written with the empty string. Callers pass a harness session id or an
 * id of their own; either way it has to be usable as a key.
 */
function assertSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        throw new Error('sessionId must be a non-empty string');
    }
}
/**
 * Exchanges are stored through splitTitleBody, so the first line of the message
 * lives in the title and only the remainder in the content. Reading the content
 * alone silently drops that first line — for an agent answer that is its lead.
 */
function exchangeText(entry) {
    const title = entry.title.trim();
    const body = entry.content.trim();
    if (!body)
        return title;
    if (!title)
        return body;
    return `${title}\n${body}`;
}
const DEFAULT_SUMMARIZER = async (exchanges) => {
    if (exchanges.length === 0)
        return 'Empty session — no exchanges to checkpoint.';
    const userMsgs = exchanges.filter(e => e.metadata.role === 'user');
    const agentMsgs = exchanges.filter(e => e.metadata.role === 'agent');
    const topics = userMsgs
        .slice(0, 5)
        .map(e => {
        const text = exchangeText(e);
        // Extract first sentence or first 120 chars as topic indicator
        const firstSentence = text.split(/[.!?\n]/)[0]?.trim() ?? text;
        return firstSentence.length > 120 ? firstSentence.slice(0, 117) + '…' : firstSentence;
    })
        .filter(Boolean);
    const decisionHints = agentMsgs
        .slice(0, 3)
        .map(e => {
        const text = exchangeText(e);
        return text.length > 100 ? text.slice(0, 97) + '…' : text;
    })
        .filter(Boolean);
    let summary = `Session checkpoint: ${exchanges.length} exchanges`;
    if (topics.length) {
        summary += `\nTopics: ${topics.map((t, i) => `${i + 1}. ${t}`).join('; ')}`;
    }
    if (decisionHints.length) {
        summary += `\nAgent responses hint at: ${decisionHints.join(' | ')}`;
    }
    return summary.length > 2000 ? summary.slice(0, 1997) + '…' : summary;
};
class SessionManager {
    store;
    onBatchFull;
    constructor(store) {
        this.store = store;
    }
    /** Live summarizer trigger when an exchange-batch fills (wired from tim-mcp). */
    setOnBatchFull(handler) {
        this.onBatchFull = handler;
    }
    async sessionStart(params) {
        const { sessionId, agentName, cwd, harness } = params;
        assertSessionId(sessionId);
        const existing = await this.store.read(sessionId);
        if (existing?.metadata.kind === 'session') {
            return existing;
        }
        return this.store.write(`Session ${sessionId}`, {
            id: sessionId,
            metadata: {
                kind: 'session',
                sessionId,
                agent: agentName,
                harness,
                cwd,
            },
        });
    }
    async startProjectSession(params) {
        const { sessionId, projectId, agentName, cwd, harness, tool, model, taskSummary } = params;
        assertSessionId(sessionId);
        const existing = await this.store.read(sessionId);
        if (existing?.metadata.kind === session_tree_js_1.KIND_SESSION) {
            if (existing.metadata.project_ref !== projectId) {
                const newProject = await this.store.requireProject(projectId);
                let newSessionsSection = await (0, session_tree_js_1.findManagedRoot)(this.store, newProject.id, session_tree_js_1.KIND_SESSIONS_ROOT);
                if (!newSessionsSection) {
                    newSessionsSection = await this.store.write(session_tree_js_1.SESSIONS_SECTION_TITLE, {
                        parentId: newProject.id,
                        metadata: { kind: session_tree_js_1.KIND_SESSIONS_ROOT, render_depth: 0, order: session_tree_js_1.SESSIONS_SECTION_ORDER },
                    });
                }
                await this.store.update(sessionId, {
                    metadata: { ...existing.metadata, project_ref: projectId },
                });
                this.store.curate().moveEntry(sessionId, newSessionsSection.id);
            }
            return (await this.store.read(sessionId));
        }
        const project = await this.store.requireProject(projectId);
        let sessionsSection = await (0, session_tree_js_1.findManagedRoot)(this.store, project.id, session_tree_js_1.KIND_SESSIONS_ROOT);
        if (!sessionsSection) {
            sessionsSection = await this.store.write(session_tree_js_1.SESSIONS_SECTION_TITLE, {
                parentId: project.id,
                metadata: { kind: session_tree_js_1.KIND_SESSIONS_ROOT, render_depth: 0, order: session_tree_js_1.SESSIONS_SECTION_ORDER },
            });
        }
        const date = new Date().toISOString();
        const title = date.slice(0, 16).replace('T', '-').replace(':', '');
        const session = await this.store.write(title, {
            id: sessionId,
            parentId: sessionsSection.id,
            metadata: {
                kind: session_tree_js_1.KIND_SESSION,
                sessionId,
                project_ref: projectId,
                agent: agentName,
                harness,
                cwd,
                date,
                batch_size: params.batchSize ?? session_tree_js_1.DEFAULT_BATCH_SIZE,
                summarizer: params.summarizer ?? { cli: 'tim-summarizer', model: 'default' },
                exchange_count: 0,
                batches_summarized: 0,
                device: os.hostname(),
                ...(tool && { tool }),
                ...(model && { model }),
                ...(taskSummary && { task_summary: taskSummary }),
            },
        });
        await this.store.write(session_tree_js_1.SUMMARY_NODE_TITLE, {
            parentId: session.id,
            metadata: { kind: session_tree_js_1.KIND_SUMMARY_ROOT, exchanges: 0, date, summary: '' },
            tags: [session_tree_js_1.SESSION_SUMMARY_TAG],
        });
        // No Batch 1 here: sessionLog creates it on the first exchange. Writing it
        // eagerly only mattered for sessions that never log anything, and there it
        // left an empty batch behind — 50 of P0063's 93 sessions carried one.
        await this.store.write(session_tree_js_1.EXCHANGES_NODE_TITLE, {
            parentId: session.id,
            metadata: { kind: session_tree_js_1.KIND_EXCHANGES_ROOT, render_depth: 0 },
        });
        return session;
    }
    async sessionLog(sessionId, entries) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const session = await this.store.read(sessionId);
        if (!session || session.metadata.kind !== 'session') {
            throw new Error(`Session not found: ${sessionId}`);
        }
        const exchanges = await this.getSessionExchanges(sessionId);
        let nextSeq = exchanges.reduce((max, e) => {
            const seq = typeof e.metadata.seq === 'number' ? e.metadata.seq : 0;
            return Math.max(max, seq);
        }, 0);
        const written = [];
        for (const exchange of entries) {
            nextSeq += 1;
            const entry = await this.store.write(exchange.content, {
                parentId: sessionId,
                metadata: {
                    kind: 'exchange',
                    role: exchange.role,
                    seq: nextSeq,
                    sessionId,
                },
            });
            written.push(entry);
        }
        return written;
    }
    /**
     * Synchronous body of logExchange for use inside `store.runExclusive`.
     * Caller must already hold the exclusive lock and have validated the session.
     */
    logExchangeSync(sessionId, entries, options = {}) {
        const session = this.store.readSync(sessionId);
        if (!session || session.metadata.kind !== session_tree_js_1.KIND_SESSION) {
            throw new Error(`Project session not found: ${sessionId}`);
        }
        const allExNodes = this.store.getChildByKindSync(sessionId, session_tree_js_1.KIND_EXCHANGES_ROOT);
        const exNode = allExNodes[0];
        if (!exNode)
            throw new Error(`Exchanges node missing for session: ${sessionId}`);
        const batchSize = typeof session.metadata.batch_size === 'number'
            ? session.metadata.batch_size
            : session_tree_js_1.DEFAULT_BATCH_SIZE;
        let allBatches = this.store.getChildByKindSync(exNode.id, session_tree_js_1.KIND_EXCHANGE_BATCH);
        let batchNode = allBatches[allBatches.length - 1] ?? null;
        if (!batchNode) {
            batchNode = this.store.writeSync('Batch 1', {
                parentId: exNode.id,
                metadata: { kind: session_tree_js_1.KIND_EXCHANGE_BATCH, batch_index: 1, order: 1 },
            });
            allBatches = [batchNode];
        }
        let usersInBatch = this.store.getChildrenBySeqSync(batchNode.id).filter(u => u.metadata.role === 'user');
        const allUserNodes = [];
        for (const b of allBatches) {
            const users = this.store.getChildrenBySeqSync(b.id).filter(u => u.metadata.role === 'user');
            allUserNodes.push(...users);
        }
        let seq = allUserNodes.reduce((m, u) => Math.max(m, typeof u.metadata.seq === 'number' ? u.metadata.seq : 0), 0);
        let currentUser = allUserNodes[allUserNodes.length - 1] ?? null;
        const result = [];
        const keyMeta = options.exchangeKey ? { exchange_key: options.exchangeKey } : {};
        for (const e of entries) {
            if (e.role === 'user') {
                if (usersInBatch.length >= batchSize) {
                    const fullBatchId = batchNode.id;
                    const fullBatchIndex = typeof batchNode.metadata.batch_index === 'number'
                        ? batchNode.metadata.batch_index
                        : allBatches.length;
                    const nextIndex = fullBatchIndex + 1;
                    batchNode = this.store.writeSync(`Batch ${nextIndex}`, {
                        parentId: exNode.id,
                        metadata: { kind: session_tree_js_1.KIND_EXCHANGE_BATCH, batch_index: nextIndex, order: nextIndex },
                    });
                    allBatches.push(batchNode);
                    usersInBatch = [];
                    this.onBatchFull?.({
                        sessionId,
                        batchId: fullBatchId,
                        batchIndex: fullBatchIndex,
                    });
                }
                seq += 1;
                currentUser = this.store.writeSync(e.content, {
                    parentId: batchNode.id,
                    metadata: { kind: session_tree_js_1.KIND_EXCHANGE, role: 'user', seq, sessionId, ...keyMeta },
                });
                usersInBatch.push(currentUser);
                result.push(currentUser);
            }
            else {
                const parentId = currentUser ? currentUser.id : batchNode.id;
                const agentSeq = currentUser ? currentUser.metadata.seq : seq;
                const a = this.store.writeSync(e.content, {
                    parentId,
                    metadata: { kind: session_tree_js_1.KIND_EXCHANGE, role: 'agent', seq: agentSeq, sessionId, ...keyMeta },
                });
                result.push(a);
            }
        }
        const { exchangeCount } = (0, session_tree_js_1.deriveCountersSync)(this.store, sessionId);
        const freshSession = this.store.readSync(sessionId);
        if (freshSession) {
            this.store.updateSync(sessionId, {
                metadata: { ...freshSession.metadata, exchange_count: exchangeCount },
            });
        }
        return result;
    }
    async logExchange(sessionId, entries) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const session = await this.store.read(sessionId);
        if (!session || session.metadata.kind !== session_tree_js_1.KIND_SESSION) {
            throw new Error(`Project session not found: ${sessionId}`);
        }
        const exNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_EXCHANGES_ROOT);
        if (!exNode)
            throw new Error(`Exchanges node missing for session: ${sessionId}`);
        return this.store.runExclusive(() => this.logExchangeSync(sessionId, entries));
    }
    /**
     * Log an exchange at most once for the given deterministic exchange key.
     * Duplicate check and writes share one exclusive transaction.
     */
    async logExchangeOnce(sessionId, exchangeKey, entries) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const session = await this.store.read(sessionId);
        if (!session || session.metadata.kind !== session_tree_js_1.KIND_SESSION) {
            throw new Error(`Project session not found: ${sessionId}`);
        }
        const exNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_EXCHANGES_ROOT);
        if (!exNode)
            throw new Error(`Exchanges node missing for session: ${sessionId}`);
        return this.store.runExclusive(() => {
            const existing = this.store.getDb().prepare(`
        SELECT 1 FROM entries
        WHERE json_extract(metadata, '$.sessionId') = ?
          AND json_extract(metadata, '$.exchange_key') = ?
          AND tombstoned_at IS NULL
        LIMIT 1
      `).get(sessionId, exchangeKey);
            if (existing)
                return [];
            return this.logExchangeSync(sessionId, entries, { exchangeKey });
        });
    }
    async showUnsummarized(sessionId) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const session = await this.store.read(sessionId);
        if (!session || session.metadata.kind !== session_tree_js_1.KIND_SESSION) {
            throw new Error(`Project session not found: ${sessionId}`);
        }
        const exNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_EXCHANGES_ROOT);
        const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_SUMMARY_ROOT);
        if (!exNode || !summaryNode)
            throw new Error(`Session subtree incomplete: ${sessionId}`);
        const batchSize = typeof session.metadata.batch_size === 'number'
            ? session.metadata.batch_size
            : session_tree_js_1.DEFAULT_BATCH_SIZE;
        const { batchesSummarized } = await (0, session_tree_js_1.deriveCounters)(this.store, sessionId);
        const exchangeBatches = (await this.store.getChildByKind(exNode.id, session_tree_js_1.KIND_EXCHANGE_BATCH))
            .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index));
        const summaryBatches = await this.store.getChildByKind(summaryNode.id, session_tree_js_1.KIND_BATCH);
        const summaryByIndex = new Map(summaryBatches.map(s => [Number(s.metadata.batch_index), s]));
        const batchHasUncovered = async (batchNode) => {
            const batchIdx = Number(batchNode.metadata.batch_index);
            const summary = summaryByIndex.get(batchIdx);
            const users = (await this.store.getChildrenBySeq(batchNode.id)).filter(u => u.metadata.role === 'user');
            if (users.length === 0)
                return false;
            if (!summary)
                return true;
            const maxSeq = Math.max(...users.map(u => Number(u.metadata.seq)));
            return maxSeq > Number(summary.metadata.seq_to);
        };
        let targetBatchIndex = null;
        let seqFloor = 0;
        for (const batchNode of exchangeBatches) {
            const batchIdx = Number(batchNode.metadata.batch_index);
            const summary = summaryByIndex.get(batchIdx);
            const users = (await this.store.getChildrenBySeq(batchNode.id)).filter(u => u.metadata.role === 'user');
            if (users.length === 0)
                continue;
            if (!summary) {
                targetBatchIndex = batchIdx;
                seqFloor = 0;
                break;
            }
            const maxSeq = Math.max(...users.map(u => Number(u.metadata.seq)));
            const seqTo = Number(summary.metadata.seq_to);
            if (maxSeq > seqTo) {
                targetBatchIndex = batchIdx;
                seqFloor = seqTo;
                break;
            }
        }
        const batchIndex = targetBatchIndex ?? batchesSummarized + 1;
        const batchNode = (targetBatchIndex != null
            ? exchangeBatches.find(b => b.metadata.batch_index === targetBatchIndex)
            : exchangeBatches.find(b => b.metadata.batch_index === batchIndex)) ?? null;
        const exchanges = [];
        if (batchNode && targetBatchIndex != null) {
            const users = (await this.store.getChildrenBySeq(batchNode.id)).filter(u => u.metadata.role === 'user');
            for (const u of users) {
                const seq = Number(u.metadata.seq);
                if (seq <= seqFloor)
                    continue;
                const replies = await this.store.getChildren(u.id);
                const agent = replies.find(r => r.metadata.role === 'agent') ?? null;
                exchanges.push({
                    seq,
                    userId: u.id,
                    userContent: exchangeText(u),
                    agentId: agent?.id ?? null,
                    agentContent: agent ? exchangeText(agent) : null,
                });
            }
        }
        const hasMore = await (async () => {
            for (const b of exchangeBatches) {
                if (Number(b.metadata.batch_index) <= batchIndex)
                    continue;
                if (await batchHasUncovered(b))
                    return true;
            }
            return false;
        })();
        // Rolling context for the next batch: the batch summary *bodies*, in batch order.
        // Selected by kind, not by tag — checkpoint nodes carry the same summary tags but
        // are not part of the batch chain. Titles ("Batch N") carry no information.
        const previousSummaries = [];
        if (summaryNode) {
            const priorBatches = await this.store.getChildByKind(summaryNode.id, session_tree_js_1.KIND_BATCH);
            priorBatches.sort((a, b) => (Number(a.metadata.batch_index) || 0) - (Number(b.metadata.batch_index) || 0));
            for (const s of priorBatches) {
                const text = (s.content || '').trim();
                if (text)
                    previousSummaries.push(text);
            }
        }
        const sessionMeta = {
            project: typeof session.metadata.project_ref === 'string' ? session.metadata.project_ref : undefined,
            tool: typeof session.metadata.tool === 'string' ? session.metadata.tool : undefined,
            model: typeof session.metadata.model === 'string' ? session.metadata.model : undefined,
            task_summary: typeof session.metadata.task_summary === 'string' ? session.metadata.task_summary : undefined,
        };
        // Best effort by design: a vocabulary lookup that fails must not stop a
        // session from being summarized. No field, old prompt, summary still runs.
        const vocabulary = sessionMeta.project
            ? await this.store
                .projectTagVocabulary(sessionMeta.project)
                .then(v => v.map(t => t.tag))
                .catch(() => [])
            : [];
        return {
            sessionId,
            summaryNodeId: summaryNode.id,
            exchangesNodeId: exNode.id,
            batchIndex,
            batchSize,
            exchanges,
            hasMore,
            previousSummaries,
            sessionMeta,
            ...(vocabulary.length > 0 ? { vocabulary } : {}),
        };
    }
    async writeBatchSummary(sessionId, batchIndex, summaryText, range, tags) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_SUMMARY_ROOT);
        if (!summaryNode)
            throw new Error(`Summary node missing for session: ${sessionId}`);
        const entry = this.store.runExclusive(() => this.writeBatchSummarySync(sessionId, summaryNode, batchIndex, summaryText, range, tags));
        await this.aggregateSessionTags(sessionId);
        return entry;
    }
    writeBatchSummarySync(sessionId, summaryNode, batchIndex, summaryText, range, tags) {
        const findExisting = () => this.store.getChildByKindSync(summaryNode.id, session_tree_js_1.KIND_BATCH)
            .find(b => b.metadata.batch_index === batchIndex);
        const upsertExisting = (existing) => {
            const existingSeqFrom = Number(existing.metadata.seq_from);
            const existingSeqTo = Number(existing.metadata.seq_to);
            const rangeCovered = range.seqFrom >= existingSeqFrom && range.seqTo <= existingSeqTo;
            if (rangeCovered)
                return existing;
            const mergedFrom = Math.min(existingSeqFrom, range.seqFrom);
            const mergedTo = Math.max(existingSeqTo, range.seqTo);
            const summarizedAt = new Date().toISOString();
            const contentTags = tags ?? [];
            const mergedTags = [
                session_tree_js_1.SESSION_SUMMARY_TAG,
                session_tree_js_1.BATCH_SUMMARY_TAG,
                ...new Set([
                    ...(existing.tags ?? []).filter(t => !session_tree_js_1.BATCH_STRUCTURAL_TAGS.has(t)),
                    ...contentTags,
                ]),
            ];
            this.store.updateSync(existing.id, {
                content: summaryText,
                metadata: {
                    ...existing.metadata,
                    kind: session_tree_js_1.KIND_BATCH,
                    batch_index: batchIndex,
                    seq_from: mergedFrom,
                    seq_to: mergedTo,
                    sessionId,
                    summarized_at: summarizedAt,
                },
                tags: mergedTags,
            });
            return this.store.readSync(existing.id);
        };
        const existing = findExisting();
        if (existing) {
            const updated = upsertExisting(existing);
            this.syncSessionBatchesSummarized(sessionId, summaryNode.id);
            return updated;
        }
        const summarizedAt = new Date().toISOString();
        const contentTags = tags ?? [];
        try {
            const node = this.store.writeSync(summaryText, {
                parentId: summaryNode.id,
                title: `Batch ${batchIndex}`,
                metadata: {
                    kind: session_tree_js_1.KIND_BATCH,
                    batch_index: batchIndex,
                    seq_from: range.seqFrom,
                    seq_to: range.seqTo,
                    sessionId,
                    summarized_at: summarizedAt,
                },
                tags: [session_tree_js_1.SESSION_SUMMARY_TAG, session_tree_js_1.BATCH_SUMMARY_TAG, ...contentTags],
            });
            this.syncSessionBatchesSummarized(sessionId, summaryNode.id);
            return node;
        }
        catch (err) {
            const code = err.code;
            if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') {
                const raced = findExisting();
                if (!raced)
                    throw err;
                const updated = upsertExisting(raced);
                this.syncSessionBatchesSummarized(sessionId, summaryNode.id);
                return updated;
            }
            throw err;
        }
    }
    syncSessionBatchesSummarized(sessionId, summaryNodeId) {
        const session = this.store.readSync(sessionId);
        if (!session)
            return;
        const batchesSummarized = this.store.getChildByKindSync(summaryNodeId, session_tree_js_1.KIND_BATCH).length;
        this.store.updateSync(sessionId, {
            metadata: { ...session.metadata, batches_summarized: batchesSummarized },
        });
    }
    /**
     * Recompute session-level content tags from batch summaries.
     *
     * The frequency bar depends on how many batches there are: with one or two,
     * every content tag qualifies — a short session has no topic drift to filter
     * out, only tags to lose, and a single-batch session could never clear a
     * two-batch bar at all. From three batches on the old `>= 2` rule returns: a
     * Summary root carrying twelve tags matches every topic and sharpens none.
     */
    async aggregateSessionTags(sessionId) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_SUMMARY_ROOT);
        if (!summaryNode)
            return null;
        const batches = await this.store.getChildByKind(summaryNode.id, session_tree_js_1.KIND_BATCH);
        const freq = new Map();
        for (const batch of batches) {
            const contentTags = (batch.tags ?? []).filter(t => !session_tree_js_1.BATCH_STRUCTURAL_TAGS.has(t));
            for (const tag of new Set(contentTags)) {
                freq.set(tag, (freq.get(tag) ?? 0) + 1);
            }
        }
        const threshold = batches.length <= 2 ? 1 : 2;
        const aggregated = [...freq.entries()]
            .filter(([, count]) => count >= threshold)
            .map(([tag]) => tag)
            .sort();
        await this.store.update(summaryNode.id, {
            tags: [session_tree_js_1.SESSION_SUMMARY_TAG, ...aggregated],
        });
        return (await this.store.read(summaryNode.id));
    }
    /** Batch summary nodes with no content tags (only structural tags). */
    async showUntagged() {
        const results = [];
        const sessions = await this.store.getByMetadataKind(session_tree_js_1.KIND_SESSION, 100);
        for (const session of sessions) {
            try {
                const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, session.id, session_tree_js_1.KIND_SUMMARY_ROOT);
                if (!summaryNode)
                    continue;
                const batches = await this.store.getChildByKind(summaryNode.id, session_tree_js_1.KIND_BATCH);
                for (const batch of batches) {
                    const contentTags = (batch.tags ?? []).filter(t => !session_tree_js_1.BATCH_STRUCTURAL_TAGS.has(t));
                    if (contentTags.length > 0)
                        continue;
                    results.push({
                        sessionId: session.id,
                        batchNodeId: batch.id,
                        batchIndex: Number(batch.metadata.batch_index),
                        title: batch.title,
                        seqFrom: Number(batch.metadata.seq_from),
                        seqTo: Number(batch.metadata.seq_to),
                    });
                }
            }
            catch {
                // Skip sessions with incomplete subtrees
            }
        }
        return results;
    }
    async rollUpSession(sessionId, fold) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_SUMMARY_ROOT);
        if (!summaryNode)
            throw new Error(`Summary node missing for session: ${sessionId}`);
        const batches = await this.store.getChildByKind(summaryNode.id, session_tree_js_1.KIND_BATCH);
        const text = await fold(batches);
        const { exchangeCount } = await (0, session_tree_js_1.deriveCounters)(this.store, sessionId);
        const date = String(summaryNode.metadata.date ?? new Date().toISOString());
        await this.store.update(summaryNode.id, {
            title: session_tree_js_1.SUMMARY_NODE_TITLE,
            content: text,
            metadata: { ...summaryNode.metadata, summary: text, exchanges: exchangeCount, date },
        });
        const updated = await this.store.read(summaryNode.id);
        return updated;
    }
    async getSessionExchanges(sessionId) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const exNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_EXCHANGES_ROOT);
        if (exNode) {
            const batches = await this.store.getChildByKind(exNode.id, session_tree_js_1.KIND_EXCHANGE_BATCH);
            const out = [];
            for (const batch of batches) {
                const users = (await this.store.getChildrenBySeq(batch.id)).filter(u => u.metadata.role === 'user');
                for (const u of users) {
                    out.push(u);
                    const replies = await this.store.getChildren(u.id);
                    for (const r of replies)
                        if (r.metadata.role === 'agent')
                            out.push(r);
                }
            }
            return out;
        }
        return this.store.getChildren(sessionId, { metadataKind: session_tree_js_1.KIND_EXCHANGE });
    }
    /** Scan all project sessions and return their unsummarized batches (cleanup sweep). */
    async showAllUnsummarized() {
        const results = [];
        const sessions = await this.store.getByMetadataKind(session_tree_js_1.KIND_SESSION, 100);
        for (const session of sessions) {
            try {
                const batch = await this.showUnsummarized(session.id);
                if (batch.exchanges.length > 0)
                    results.push(batch);
            }
            catch {
                // Skip sessions with incomplete subtrees
            }
        }
        return results;
    }
    async checkpoint(sessionId, opts = {}) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const session = await this.store.read(sessionId);
        if (!session || session.metadata.kind !== 'session') {
            throw new Error(`Session not found: ${sessionId}`);
        }
        // Find or create Summary node under session
        let summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_SUMMARY_ROOT);
        if (!summaryNode) {
            const date = new Date().toISOString();
            summaryNode = await this.store.write(session_tree_js_1.SUMMARY_NODE_TITLE, {
                parentId: sessionId,
                metadata: { kind: session_tree_js_1.KIND_SUMMARY_ROOT, exchanges: 0, date, summary: '' },
                tags: [session_tree_js_1.SESSION_SUMMARY_TAG],
            });
        }
        if (opts.handoffNote) {
            await this.store.update(summaryNode.id, {
                metadata: {
                    ...summaryNode.metadata,
                    handoff_note: opts.handoffNote,
                },
            });
            const verifiedRoot = await this.store.read(summaryNode.id);
            const noteOk = typeof verifiedRoot?.metadata.handoff_note === 'string' &&
                verifiedRoot.metadata.handoff_note === opts.handoffNote;
            if (!noteOk) {
                throw new Error('Handoff note verification failed: note not durable');
            }
            summaryNode = verifiedRoot;
        }
        const exchanges = await this.getSessionExchanges(sessionId);
        const summarize = opts.summarize ?? DEFAULT_SUMMARIZER;
        const summaryText = await summarize(exchanges);
        const summary = await this.store.write(summaryText, {
            parentId: summaryNode.id,
            metadata: {
                kind: 'checkpoint',
                sessionId,
                count: exchanges.length,
            },
            tags: [session_tree_js_1.SESSION_SUMMARY_TAG, session_tree_js_1.BATCH_SUMMARY_TAG],
        });
        await this.store.link(summary.id, sessionId, 'summarizes');
        const verifiedSummary = await this.store.read(summary.id);
        const edges = await this.store.getEdges(summary.id, 'outgoing');
        const hasSummarizesEdge = edges.some(e => e.targetId === sessionId && e.type === 'summarizes');
        if (!verifiedSummary || !hasSummarizesEdge) {
            throw new Error('Checkpoint verification failed: summary not durable');
        }
        if (opts.runDecay === true) {
            await this.store.runDecay({
                before: session.createdAt,
                exclude: [sessionId, summary.id],
            });
        }
        return summary;
    }
    /** Upsert session-summary-root content after checkpoint / rollup. */
    async updateSessionSummary(sessionId, summaryText) {
        sessionId = this.store.resolveSessionAlias(sessionId);
        const session = await this.store.read(sessionId);
        if (!session || session.metadata.kind !== session_tree_js_1.KIND_SESSION) {
            throw new Error(`Project session not found: ${sessionId}`);
        }
        let summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, sessionId, session_tree_js_1.KIND_SUMMARY_ROOT);
        const now = new Date().toISOString();
        if (summaryNode) {
            await this.store.update(summaryNode.id, {
                title: session_tree_js_1.SUMMARY_NODE_TITLE,
                content: summaryText,
                metadata: {
                    ...summaryNode.metadata,
                    kind: session_tree_js_1.KIND_SUMMARY_ROOT,
                    summary: summaryText,
                    date: now,
                },
            });
            return (await this.store.read(summaryNode.id));
        }
        summaryNode = await this.store.write(summaryText, {
            parentId: sessionId,
            title: session_tree_js_1.SUMMARY_NODE_TITLE,
            metadata: {
                kind: session_tree_js_1.KIND_SUMMARY_ROOT,
                sessionId,
                summary: summaryText,
                exchanges: 0,
                date: now,
            },
            tags: [session_tree_js_1.SESSION_SUMMARY_TAG],
        });
        return summaryNode;
    }
    async resumeSession(oldSessionId, opts = {}) {
        const canonical = this.store.resolveSessionAlias(oldSessionId);
        const session = await this.store.read(canonical);
        if (!session || session.metadata.kind !== session_tree_js_1.KIND_SESSION) {
            throw new Error(`Session not found: ${oldSessionId}`);
        }
        const exNode = await (0, session_tree_js_1.findChildByKind)(this.store, canonical, session_tree_js_1.KIND_EXCHANGES_ROOT);
        if (!exNode) {
            throw new Error(`Session uses legacy format and cannot be resumed: ${oldSessionId}`);
        }
        const projectRef = typeof session.metadata.project_ref === 'string'
            ? session.metadata.project_ref
            : undefined;
        if (opts.boundProjectId && projectRef && projectRef !== opts.boundProjectId) {
            throw new Error(`Session ${canonical} belongs to project ${projectRef}, not ${opts.boundProjectId}`);
        }
        const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, canonical, session_tree_js_1.KIND_SUMMARY_ROOT);
        const warnings = [];
        const newHarnessId = opts.newHarnessId?.trim() || undefined;
        if (newHarnessId && newHarnessId !== canonical) {
            const existing = await this.store.read(newHarnessId);
            if (existing?.metadata.kind === session_tree_js_1.KIND_SESSION) {
                const { exchangeCount } = await (0, session_tree_js_1.deriveCounters)(this.store, newHarnessId);
                if (exchangeCount > 0) {
                    throw new Error(`Harness session ${newHarnessId} already has ${exchangeCount} exchanges — ` +
                        `start fresh or resume from that session instead`);
                }
            }
            const fresh = (await this.store.read(canonical));
            const resumedBy = Array.isArray(fresh.metadata.resumed_by)
                ? [...fresh.metadata.resumed_by]
                : [];
            if (!resumedBy.includes(newHarnessId))
                resumedBy.push(newHarnessId);
            const toolHistory = Array.isArray(fresh.metadata.tool_history)
                ? [...fresh.metadata.tool_history]
                : typeof fresh.metadata.tool === 'string' ? [fresh.metadata.tool] : [];
            if (opts.tool && toolHistory[toolHistory.length - 1] !== opts.tool) {
                toolHistory.push(opts.tool);
            }
            await this.store.update(canonical, {
                metadata: {
                    ...fresh.metadata,
                    resumed_by: resumedBy,
                    resumed_at: new Date().toISOString(),
                    tool_history: toolHistory,
                    ...(opts.tool && { tool: opts.tool }),
                    ...(opts.model && { model: opts.model }),
                },
            });
            this.store.upsertSessionAlias(newHarnessId, canonical);
        }
        else if (!newHarnessId) {
            warnings.push('No harness session id available — alias not recorded; ' +
                'new exchanges may open a new session.');
        }
        const batchSummaries = summaryNode
            ? (await this.store.getChildByKind(summaryNode.id, session_tree_js_1.KIND_BATCH))
                .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index))
                .map(b => ({
                batchIndex: Number(b.metadata.batch_index),
                seqFrom: Number(b.metadata.seq_from),
                seqTo: Number(b.metadata.seq_to),
                text: b.content ?? '',
            }))
            : [];
        if (batchSummaries.length === 0) {
            warnings.push('No batch summaries yet — summarizer may be behind.');
        }
        const rawCount = opts.rawCount ?? 10;
        const exBatches = (await this.store.getChildByKind(exNode.id, session_tree_js_1.KIND_EXCHANGE_BATCH))
            .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index));
        const users = [];
        for (const b of exBatches) {
            users.push(...(await this.store.getChildrenBySeq(b.id)).filter(u => u.metadata.role === 'user'));
        }
        users.sort((a, b) => Number(a.metadata.seq) - Number(b.metadata.seq));
        const recentUsers = users.slice(-rawCount);
        const recentExchanges = [];
        for (const u of recentUsers) {
            const replies = await this.store.getChildren(u.id);
            const agent = replies.find(r => r.metadata.role === 'agent') ?? null;
            recentExchanges.push({
                seq: Number(u.metadata.seq),
                userContent: exchangeText(u),
                agentContent: agent ? exchangeText(agent) : null,
            });
        }
        const freshSession = (await this.store.read(canonical));
        const handoffNote = typeof summaryNode?.metadata.handoff_note === 'string'
            ? summaryNode.metadata.handoff_note
            : undefined;
        return {
            sessionId: canonical,
            sessionMeta: {
                project: typeof freshSession.metadata.project_ref === 'string'
                    ? freshSession.metadata.project_ref : undefined,
                date: typeof freshSession.metadata.date === 'string'
                    ? freshSession.metadata.date : undefined,
                tool: typeof freshSession.metadata.tool === 'string'
                    ? freshSession.metadata.tool : undefined,
                toolHistory: Array.isArray(freshSession.metadata.tool_history)
                    ? freshSession.metadata.tool_history : [],
                exchangeCount: typeof freshSession.metadata.exchange_count === 'number'
                    ? freshSession.metadata.exchange_count : 0,
                taskSummary: typeof freshSession.metadata.task_summary === 'string'
                    ? freshSession.metadata.task_summary : undefined,
            },
            sessionSummary: summaryNode?.content ?? '',
            ...(handoffNote !== undefined && { handoffNote }),
            batchSummaries,
            recentExchanges,
            warnings,
        };
    }
    /**
     * Delete checkpoint nodes whose session rollup already exists on the Summary root.
     * Sweep all sessions when sessionId omitted. Returns count deleted.
     */
    async reapCoveredCheckpoints(sessionId) {
        const sessionIds = sessionId
            ? [this.store.resolveSessionAlias(sessionId)]
            : (await this.store.getByMetadataKind(session_tree_js_1.KIND_SESSION, 10000)).map(s => s.id);
        let reaped = 0;
        for (const sid of sessionIds) {
            const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, sid, session_tree_js_1.KIND_SUMMARY_ROOT);
            if (!summaryNode)
                continue;
            const rollup = summaryNode.metadata.summary;
            if (typeof rollup !== 'string' || !rollup.trim())
                continue;
            const checkpoints = await this.store.getChildByKind(summaryNode.id, 'checkpoint');
            for (const cp of checkpoints) {
                const edges = await this.store.getEdges(cp.id, 'outgoing');
                for (const e of edges) {
                    if (e.type === 'summarizes') {
                        await this.store.unlink(e.id);
                    }
                }
                await this.store.delete(cp.id, true);
                reaped++;
            }
        }
        return reaped;
    }
    async listResumableSessions(projectRef, limit = 10) {
        const project = await this.store.requireProject(projectRef);
        const rows = this.store.listProjectSessionsByActivity(project.id, limit);
        const out = [];
        for (const { id, lastActivity } of rows) {
            const session = await this.store.read(id);
            if (!session)
                continue;
            const summaryNode = await (0, session_tree_js_1.findChildByKind)(this.store, id, session_tree_js_1.KIND_SUMMARY_ROOT);
            const summaryFirstLine = (summaryNode?.content ?? '').split('\n').find(l => l.trim())?.trim() ?? '';
            out.push({
                sessionId: id,
                title: session.title,
                date: typeof session.metadata.date === 'string' ? session.metadata.date : undefined,
                lastActivity,
                tool: typeof session.metadata.tool === 'string' ? session.metadata.tool : undefined,
                taskSummary: typeof session.metadata.task_summary === 'string'
                    ? session.metadata.task_summary : undefined,
                exchangeCount: typeof session.metadata.exchange_count === 'number'
                    ? session.metadata.exchange_count : 0,
                summaryFirstLine,
            });
        }
        return out;
    }
    static PROJECT_STATS_MARKER = '## Project Stats';
    /** Refresh project-root stats line (entry count + last activity). */
    async updateProjectSummary(projectId) {
        const project = await this.store.requireProject(projectId);
        const stats = this.store.getProjectEntryStats(project.id);
        const statsLine = `${stats.count} entries · Last activity: ${stats.lastActivity}`;
        const existing = project.content ?? '';
        const marker = SessionManager.PROJECT_STATS_MARKER;
        const blockRe = new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n.*$`, 'm');
        const merged = blockRe.test(existing)
            ? existing.replace(blockRe, `${marker}\n${statsLine}`)
            : existing.trimEnd()
                ? `${existing.trimEnd()}\n\n${marker}\n${statsLine}`
                : `${marker}\n${statsLine}`;
        await this.store.update(project.id, {
            title: project.title,
            content: merged,
        });
        return (await this.store.read(project.id));
    }
}
exports.SessionManager = SessionManager;
async function nextAutoProjectLabel(store) {
    return store.allocateNextProjectLabel();
}
function isAutoProjectBlocked(cwd) {
    const resolved = path.resolve(cwd);
    const home = path.resolve(os.homedir());
    if (resolved === home)
        return true;
    if (resolved === '/tmp' || resolved.startsWith('/tmp/'))
        return true;
    if (resolved === '/var/tmp' || resolved.startsWith('/var/tmp/'))
        return true;
    const tasksDir = path.join(home, 'projects', 'tasks');
    if (resolved === tasksDir || resolved.startsWith(`${tasksDir}${path.sep}`))
        return true;
    return false;
}
/**
 * Auto-create a project from a directory name when no .tim-project binding exists.
 * Re-bind to an existing project with the same directory alias. Reversible via
 * irrelevant flag on the project root.
 */
/** Latest kind=session entry for a project whose metadata.cwd matches. */
async function resolveCurrentSession(store, projectLabel, cwd) {
    const project = await store.requireProject(projectLabel);
    const sessionsSection = await (0, session_tree_js_1.findChildByKind)(store, project.id, session_tree_js_1.KIND_SESSIONS_ROOT);
    if (!sessionsSection)
        return null;
    const sessions = await store.getChildByKind(sessionsSection.id, session_tree_js_1.KIND_SESSION);
    if (sessions.length === 0)
        return null;
    let candidates = sessions;
    if (cwd !== undefined) {
        const resolvedCwd = path.resolve(cwd);
        candidates = sessions.filter(s => typeof s.metadata.cwd === 'string' &&
            path.resolve(s.metadata.cwd) === resolvedCwd);
        if (candidates.length === 0)
            return null;
    }
    candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return candidates[0] ?? null;
}
async function ensureProjectForPath(store, cwd) {
    const config = (0, tim_core_1.loadConfig)();
    if (config.autoProject === false)
        return null;
    const resolvedPath = path.resolve(cwd);
    if (isAutoProjectBlocked(resolvedPath))
        return null;
    const dirName = path.basename(resolvedPath);
    if (!dirName || dirName === '.' || dirName === '/')
        return null;
    const byPath = await store.findProjectByPath(resolvedPath);
    if (byPath && !byPath.irrelevant) {
        const label = typeof byPath.metadata.label === 'string' ? byPath.metadata.label : byPath.id;
        return { label, entry: byPath, created: false };
    }
    const alias = dirName.toLowerCase();
    const byAlias = await store.resolveProjectLabel(alias);
    if (byAlias.status === 'found') {
        const entry = await store.read(byAlias.label);
        if (entry && entry.metadata.kind === 'project' && !entry.irrelevant) {
            const existingPath = typeof entry.metadata.path === 'string' ? entry.metadata.path : '';
            if (!existingPath) {
                await store.update(entry.id, {
                    metadata: { ...entry.metadata, path: resolvedPath },
                });
            }
            return { label: byAlias.label, entry, created: false };
        }
    }
    if (byAlias.status === 'ambiguous') {
        // Do not mint another project with the same contested alias.
        return null;
    }
    const timJsonPath = path.join(resolvedPath, 'tim.json');
    if (fs.existsSync(timJsonPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(timJsonPath, 'utf8'));
            const label = raw.project;
            if (typeof label === 'string') {
                const resolved = await store.resolveProjectLabel(label);
                if (resolved.status === 'found') {
                    const entry = await store.read(resolved.label);
                    if (entry && entry.metadata.kind === 'project' && !entry.irrelevant) {
                        return { label: resolved.label, entry, created: false };
                    }
                }
            }
        }
        catch {
            // ignore malformed tim.json
        }
    }
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const label = await nextAutoProjectLabel(store);
        try {
            const entry = await store.createProject(label, {
                content: `${dirName} | Active`,
                metadata: { name: dirName, path: resolvedPath, auto_created: true },
                aliases: [alias],
            });
            // Auto-created projects get the same standard sections as every other
            // creation path — the schema is the single owner of that list.
            await (0, project_schema_init_js_1.ensureProjectSchema)(store, entry.id);
            return { label, entry, created: true };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < maxAttempts - 1 && msg.includes('already exists'))
                continue;
            throw err;
        }
    }
    return null;
}
//# sourceMappingURL=session.js.map