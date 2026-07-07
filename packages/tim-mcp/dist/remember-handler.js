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
exports.rememberDeps = void 0;
exports.appendRememberLog = appendRememberLog;
exports.getProjectParent = getProjectParent;
exports.spawnRememberSubprocess = spawnRememberSubprocessImpl;
exports.handleTimRemember = handleTimRemember;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const query_variants_js_1 = require("./query-variants.js");
function appendRememberLog(line) {
    try {
        const logPath = path.join((0, tim_core_1.getTimDir)(), 'remember.log');
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        // ignore write failures
    }
}
async function getProjectParent(store, entryId) {
    const entry = await store.read(entryId);
    if (!entry)
        return [];
    let currentId = entry.parentId;
    for (let depth = 0; depth < 5 && currentId; depth++) {
        const parent = await store.read(currentId);
        if (!parent)
            break;
        if (parent.metadata?.kind === 'project') {
            const label = typeof parent.metadata.label === 'string'
                ? parent.metadata.label
                : parent.title;
            return [{ id: parent.id, title: label.slice(0, 80) }];
        }
        currentId = parent.parentId;
    }
    return [];
}
function filterByProjectScope(store, entries, projectScope) {
    if (!projectScope)
        return entries;
    return entries.filter((entry) => store.getProjectLabel(entry.id) === projectScope);
}
function filterValidRanked(ranked) {
    return ranked.filter((item) => typeof item.node_id === 'string' &&
        typeof item.confidence === 'number' &&
        item.confidence >= 0 &&
        item.confidence <= 1 &&
        typeof item.reasoning === 'string');
}
function buildEmptyResult(opts, startTime, fallback, candidatesFts = 0) {
    return {
        query: opts.query,
        results: [],
        meta: {
            latency_ms: Date.now() - startTime,
            candidates_fts: candidatesFts,
            candidates_after_rerank: 0,
            dropped_hallucinated: 0,
            sub_process_model: '',
            sub_process_tokens_in: 0,
            sub_process_tokens_out: 0,
            fallback_used: fallback,
        },
    };
}
function toOutputShape(ranked, candidatesMap) {
    const candidate = candidatesMap.get(ranked.node_id);
    return {
        node_id: ranked.node_id,
        title: candidate?.title ?? '',
        relevance: ranked.confidence,
        excerpt: candidate?.excerpt ?? '',
        parents: candidate?.parents ?? [],
        reasoning: ranked.reasoning,
    };
}
function ftsHitToResultItem(hit, candidate) {
    return {
        node_id: hit.id,
        title: candidate?.title ?? hit.title.slice(0, 80),
        relevance: 0,
        excerpt: candidate?.excerpt ?? (hit.content || '').slice(0, 200),
        parents: candidate?.parents ?? [],
    };
}
async function prefetchCandidates(store, hits) {
    return Promise.all(hits.map(async (hit) => {
        const entry = await store.read(hit.id);
        if (!entry) {
            return {
                id: hit.id,
                title: hit.title.slice(0, 80),
                excerpt: (hit.content || '').slice(0, 200),
                parents: [],
            };
        }
        return {
            id: entry.id,
            title: entry.title.slice(0, 80),
            excerpt: (entry.content || '').slice(0, 200),
            parents: await getProjectParent(store, entry.id),
        };
    }));
}
function spawnRememberSubprocessImpl(input, hardTimeoutMs) {
    return new Promise((resolve) => {
        const subprocessPath = path.resolve(__dirname, '..', '..', 'tim-summarizer', 'dist', 'remember-query.js');
        const child = (0, child_process_1.spawn)('node', [subprocessPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
        const hardTimer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
        }, hardTimeoutMs);
        child.on('close', (code) => {
            clearTimeout(hardTimer);
            if (timedOut) {
                resolve({
                    ranked: null,
                    model: 'timeout',
                    tokensIn: 0,
                    tokensOut: 0,
                    fallback: 'timeout',
                });
                return;
            }
            if (code !== 0) {
                appendRememberLog(`SPAWN_FAIL exit=${code} stderr=${stderr.slice(0, 500)}`);
                resolve({
                    ranked: null,
                    model: 'spawn-fail',
                    tokensIn: 0,
                    tokensOut: 0,
                    fallback: 'error',
                });
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            }
            catch {
                appendRememberLog(`INVALID_JSON stdout=${stdout.slice(0, 500)}`);
                resolve({
                    ranked: null,
                    model: 'invalid-json',
                    tokensIn: 0,
                    tokensOut: 0,
                    fallback: 'invalid_json',
                });
            }
        });
        child.on('error', (err) => {
            clearTimeout(hardTimer);
            appendRememberLog(`SPAWN_ERROR err=${err.message}`);
            resolve({
                ranked: null,
                model: 'spawn-error',
                tokensIn: 0,
                tokensOut: 0,
                fallback: 'error',
            });
        });
    });
}
/** Injectable subprocess spawn — tests replace this without patching ESM internals. */
exports.rememberDeps = {
    spawnRememberSubprocess: spawnRememberSubprocessImpl,
};
function buildFtsFallbackResult(opts, deduped, startTime, rerankResult, candidatesMap, candidatesFts) {
    const hits = deduped.slice(0, opts.topK);
    return {
        query: opts.query,
        results: hits.map((hit) => ftsHitToResultItem(hit, candidatesMap.get(hit.id))),
        meta: {
            latency_ms: Date.now() - startTime,
            candidates_fts: candidatesFts,
            candidates_after_rerank: hits.length,
            dropped_hallucinated: 0,
            sub_process_model: rerankResult.model,
            sub_process_tokens_in: rerankResult.tokensIn,
            sub_process_tokens_out: rerankResult.tokensOut,
            fallback_used: rerankResult.fallback,
        },
    };
}
async function handleTimRemember(store, opts) {
    const startTime = Date.now();
    const auditParts = [];
    const config = (0, tim_core_1.loadConfig)();
    const hardTimeoutMs = config.remember?.hard_timeout_ms ?? 8000;
    const variants = (0, query_variants_js_1.expandQueryVariants)(opts.query);
    auditParts.push(`variants=${variants.length}`);
    const ftsHits = await Promise.all(variants.map((query) => store.search({
        query,
        topK: opts.topK * 4,
        searchType: 'fts',
    })));
    let deduped = (0, query_variants_js_1.dedupeById)(ftsHits.flat());
    deduped = filterByProjectScope(store, deduped, opts.projectScope);
    auditParts.push(`fts=${deduped.length}`);
    if (deduped.length === 0) {
        appendRememberLog(`no_fts_hits query="${opts.query.slice(0, 80)}"`);
        return buildEmptyResult(opts, startTime, 'no_fts_hits', 0);
    }
    let batchSummaries = [];
    if (opts.includeBatchSummaries) {
        const sessionId = (0, tim_core_1.resolveActiveSessionId)({});
        const summaries = await store.getRecentBatchSummaries({
            limit: 5,
            maxAgeDays: 30,
            sessionId: sessionId ?? undefined,
            root: opts.projectScope,
        });
        batchSummaries = summaries.map((summary) => ({
            id: summary.id,
            title: summary.title.slice(0, 80),
            excerpt: (summary.content || '').slice(0, 300),
        }));
    }
    const topCandidates = deduped.slice(0, 30);
    const candidatesForRerank = await prefetchCandidates(store, topCandidates);
    const candidatesMap = new Map(candidatesForRerank.map((candidate) => [candidate.id, candidate]));
    const rerankInput = {
        query: opts.query,
        candidates: candidatesForRerank,
        batchSummaries,
        topK: opts.topK,
    };
    const rerankStart = Date.now();
    const rerankResult = await exports.rememberDeps.spawnRememberSubprocess(rerankInput, hardTimeoutMs);
    const rerankMs = Date.now() - rerankStart;
    if (rerankMs < 100) {
        auditParts.push('suspiciously_fast=true');
    }
    const needsFtsFallback = rerankResult.fallback !== 'none' ||
        !rerankResult.ranked ||
        rerankResult.ranked.length === 0;
    if (needsFtsFallback) {
        const effectiveRerank = rerankResult.fallback !== 'none'
            ? rerankResult
            : { ...rerankResult, fallback: 'all_chain_failed', ranked: null };
        appendRememberLog(`fallback=${effectiveRerank.fallback} query="${opts.query.slice(0, 80)}" ${auditParts.join(' ')} latency_ms=${Date.now() - startTime}`);
        return buildFtsFallbackResult(opts, deduped, startTime, effectiveRerank, candidatesMap, deduped.length);
    }
    const ranked = rerankResult.ranked;
    const schemaValid = filterValidRanked(ranked);
    const rankedIds = schemaValid.map((item) => item.node_id);
    const existingIds = await store.entryExistsBatch(rankedIds);
    const verified = schemaValid.filter((item) => existingIds.has(item.node_id));
    const droppedCount = rankedIds.length - verified.length;
    auditParts.push(`dropped_hallucinated=${droppedCount}`);
    const finalResults = verified
        .filter((item) => item.confidence >= opts.minConfidence)
        .slice(0, opts.topK);
    appendRememberLog(`query="${opts.query.slice(0, 80)}" ${auditParts.join(' ')} latency_ms=${Date.now() - startTime} model=${rerankResult.model} fallback=${rerankResult.fallback}`);
    return {
        query: opts.query,
        results: finalResults.map((item) => toOutputShape(item, candidatesMap)),
        meta: {
            latency_ms: Date.now() - startTime,
            candidates_fts: deduped.length,
            candidates_after_rerank: verified.length,
            dropped_hallucinated: droppedCount,
            sub_process_model: rerankResult.model,
            sub_process_tokens_in: rerankResult.tokensIn,
            sub_process_tokens_out: rerankResult.tokensOut,
            fallback_used: 'none',
        },
    };
}
//# sourceMappingURL=remember-handler.js.map