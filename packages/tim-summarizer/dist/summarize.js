#!/usr/bin/env node
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
exports.PROJECT_SUMMARY_MARKER = void 0;
exports.mergeProjectSummary = mergeProjectSummary;
exports.runProjectSummary = runProjectSummary;
exports.processCurationQueue = processCurationQueue;
exports.runSummarizerLoop = runSummarizerLoop;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
const mcp_client_js_1 = require("./mcp-client.js");
const generate_summary_js_1 = require("./generate-summary.js");
exports.PROJECT_SUMMARY_MARKER = '## Project Summary';
/**
 * Idempotently merge a project summary into the project content body.
 * Strips any existing `## Project Summary` block first, so running it twice
 * yields exactly one block — matching the renderer's first-occurrence parse.
 */
function mergeProjectSummary(content, summary) {
    const base = content.split(exports.PROJECT_SUMMARY_MARKER)[0].trimEnd();
    const block = `${exports.PROJECT_SUMMARY_MARKER}\n${summary.trim()}`;
    return base ? `${base}\n\n${block}` : block;
}
function resolveDbPath() {
    if (process.env.TIM_DB_PATH)
        return process.env.TIM_DB_PATH;
    const config = (0, tim_core_1.loadConfig)();
    return config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
/**
 * Generate a project-level summary from all session summaries and write it
 * into project.content under `## Project Summary`. Returns true when written,
 * false when skipped (no sessions, or every CLI failed → leave content as-is).
 */
async function runProjectSummary(label) {
    const store = new tim_store_1.TimStore(resolveDbPath());
    try {
        const result = await store.loadProject(label);
        if (!result)
            throw new Error(`Project not found: ${label}`);
        // Collect batch summary content from each session-summary-root node.
        // The root nodes themselves have empty content; real summaries are in #batch-summary children.
        const sessionNodes = result.children
            .filter(c => c.tags.includes('#session-summary'))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (sessionNodes.length === 0)
            return false;
        const summaries = [];
        for (const session of sessionNodes) {
            const children = await store.getChildren(session.id);
            const batchSummaries = children
                .filter(c => c.tags.includes('#batch-summary'))
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map(c => c.content?.trim() || c.title.trim())
                .filter(Boolean);
            if (batchSummaries.length > 0) {
                summaries.push(...batchSummaries);
            }
            else if (session.content?.trim()) {
                summaries.push(session.content.trim());
            }
        }
        if (summaries.length === 0)
            return false;
        const summary = await (0, generate_summary_js_1.generateProjectSummary)(summaries);
        if (!summary)
            return false; // total CLI failure → write nothing
        const newContent = mergeProjectSummary(result.project.content, summary);
        await store.update(result.project.id, {
            title: result.project.title,
            content: newContent,
        });
        const sessions = new tim_store_1.SessionManager(store);
        await sessions.updateProjectSummary(label);
        await processCurationQueue(store, label);
        return true;
    }
    finally {
        store.close();
    }
}
function parseProjectSummaryArg(argv) {
    const idx = argv.indexOf('--project-summary');
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('-'))
        return argv[idx + 1];
    const eq = argv.find(a => a.startsWith('--project-summary='));
    if (eq)
        return eq.slice('--project-summary='.length) || null;
    return null;
}
function seqRange(batch) {
    const seqs = batch.exchanges.map(e => e.seq);
    return { seqFrom: Math.min(...seqs), seqTo: Math.max(...seqs) };
}
function entryText(entry) {
    return [entry.title, entry.content].filter(Boolean).join('\n').trim();
}
/** Process pending curation-queue entries via LLM (duplicates merge, decay confirm). */
async function processCurationQueue(store, projectLabel) {
    const mgr = store.consolidate();
    const pending = await mgr.getCurationQueue(projectLabel, 'pending');
    let processed = 0;
    for (const item of pending) {
        const meta = item.metadata;
        const consolidation = meta.consolidation;
        if (consolidation === 'duplicate' && Array.isArray(meta.pair) && meta.pair.length === 2) {
            const [keepId, dropId] = meta.pair;
            const keep = await store.read(keepId);
            const drop = await store.read(dropId);
            if (!keep || !drop) {
                await mgr.setCurationRejected(item.id);
                continue;
            }
            const batch = {
                sessionId: 'curation',
                summaryNodeId: '',
                exchangesNodeId: '',
                batchIndex: 1,
                batchSize: 2,
                exchanges: [
                    {
                        seq: 1,
                        userId: keepId,
                        userContent: entryText(keep),
                        agentId: dropId,
                        agentContent: entryText(drop),
                    },
                ],
                hasMore: false,
                previousSummaries: [],
                sessionMeta: { project: projectLabel },
            };
            const raw = await (0, generate_summary_js_1.generateSummary)(batch);
            const merged = raw === generate_summary_js_1.FALLBACK_MARKER
                ? `${entryText(keep)}\n\n---\n\n${entryText(drop)}`
                : (0, generate_summary_js_1.extractTags)(raw).body;
            await store.update(keepId, {
                content: merged,
                title: keep.title,
            });
            await store.update(dropId, { irrelevant: true });
            await mgr.setCurationDone(item.id);
            processed += 1;
            continue;
        }
        if (consolidation === 'decay' && typeof meta.target === 'string') {
            const target = await store.read(meta.target);
            if (!target) {
                await mgr.setCurationRejected(item.id);
                continue;
            }
            const batch = {
                sessionId: 'curation',
                summaryNodeId: '',
                exchangesNodeId: '',
                batchIndex: 1,
                batchSize: 1,
                exchanges: [
                    {
                        seq: 1,
                        userId: target.id,
                        userContent: `Should this memory entry be marked irrelevant (decay)? Entry:\n${entryText(target)}\n` +
                            `Reason queued: ${String(meta.reason ?? '')}\n` +
                            `Reply DECAY to confirm or KEEP to reject.`,
                        agentId: null,
                        agentContent: null,
                    },
                ],
                hasMore: false,
                previousSummaries: [],
                sessionMeta: { project: projectLabel },
            };
            const raw = await (0, generate_summary_js_1.generateSummary)(batch);
            const verdict = raw === generate_summary_js_1.FALLBACK_MARKER
                ? (0, generate_summary_js_1.generateSummaryHeuristic)(batch)
                : (0, generate_summary_js_1.extractTags)(raw).body;
            const decay = /\bDECAY\b/i.test(verdict) && !/\bKEEP\b/i.test(verdict);
            if (decay) {
                await store.update(meta.target, { irrelevant: true });
                await mgr.setCurationDone(item.id);
            }
            else {
                await mgr.setCurationRejected(item.id);
            }
            processed += 1;
        }
    }
    return processed;
}
async function postSummarizerHandoff(sessionId) {
    const store = new tim_store_1.TimStore(resolveDbPath());
    try {
        const session = await store.read(sessionId);
        if (!session || session.metadata.kind !== tim_store_1.KIND_SESSION)
            return;
        const sessions = new tim_store_1.SessionManager(store);
        const summaryNode = await (0, tim_store_1.findChildByKind)(store, sessionId, tim_store_1.KIND_SUMMARY_ROOT);
        const text = String(summaryNode?.content || summaryNode?.metadata.summary || '').trim();
        if (text) {
            await sessions.updateSessionSummary(sessionId, text);
        }
        const projectRef = typeof session.metadata.project_ref === 'string' ? session.metadata.project_ref : null;
        if (projectRef) {
            await sessions.updateProjectSummary(projectRef);
            await processCurationQueue(store, projectRef);
        }
    }
    finally {
        store.close();
    }
}
async function runSummarizerLoop(sessionId) {
    const client = await (0, mcp_client_js_1.connectTimMcp)();
    let written = 0;
    const onMCPError = async (tool, error, stack) => {
        try {
            await (0, mcp_client_js_1.callTimTool)(client, 'tim_error_log', { tool, error, stack, sessionId });
        }
        catch {
            // Non-critical — don't fail the summarizer if error logging fails
        }
    };
    try {
        let batch = await (0, mcp_client_js_1.callTimTool)(client, 'tim_show_unsummarized', { sessionId });
        while (batch.exchanges.length > 0) {
            const raw = await (0, generate_summary_js_1.generateSummary)(batch, onMCPError);
            const { seqFrom, seqTo } = seqRange(batch);
            let summary;
            let tags;
            if (raw === generate_summary_js_1.FALLBACK_MARKER) {
                summary =
                    `[ALL SUMMARIZER CLIs FAILED — main agent please resummarize batch ${batch.batchIndex}]\n` +
                        `${batch.exchanges.map(e => `Q: ${e.userContent.trim().slice(0, 200)}`).join('\n')}`;
                tags = undefined;
            }
            else {
                const extracted = (0, generate_summary_js_1.extractTags)(raw);
                summary = extracted.body;
                tags = extracted.tags.length > 0 ? extracted.tags : undefined;
            }
            await (0, mcp_client_js_1.callTimTool)(client, 'tim_write_batch_summary', {
                sessionId,
                batchIndex: batch.batchIndex,
                summary,
                seqFrom,
                seqTo,
                ...(tags && { tags }),
            });
            written += 1;
            if (!batch.hasMore)
                break;
            batch = await (0, mcp_client_js_1.callTimTool)(client, 'tim_show_unsummarized', { sessionId });
        }
    }
    finally {
        await (0, mcp_client_js_1.callTimTool)(client, 'tim_rollup_session_summary', { sessionId });
        await client.close();
        await postSummarizerHandoff(sessionId);
    }
    return written;
}
async function main() {
    // Project-summary mode: aggregate session summaries into project.content
    const projectLabel = parseProjectSummaryArg(process.argv);
    if (projectLabel) {
        try {
            const wrote = await runProjectSummary(projectLabel);
            console.error(`tim-summarizer: project summary for ${projectLabel} → ${wrote ? 'written' : 'skipped'}`);
            process.exit(0);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`tim-summarizer project-summary failed: ${msg}`);
            process.exit(1);
        }
    }
    const sessionId = process.env.TIM_SESSION_ID;
    if (!sessionId) {
        console.error('TIM_SESSION_ID is required');
        process.exit(1);
    }
    try {
        const count = await runSummarizerLoop(sessionId);
        console.error(`tim-summarizer: wrote ${count} batch summary(ies) for ${sessionId}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`tim-summarizer failed: ${msg}`);
        process.exit(1);
    }
}
const isMain = process.argv[1]?.endsWith('summarize.js') || process.argv[1]?.endsWith('summarize.ts');
if (isMain) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
//# sourceMappingURL=summarize.js.map