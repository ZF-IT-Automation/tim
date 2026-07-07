"use strict";
// TIM MCP Server — v0.1.0-alpha
// MCP stdio server with curation, session, and core memory tools.
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
exports.TOOL_DEFS = void 0;
exports.createMcpServer = createMcpServer;
exports.createHttpServer = createHttpServer;
exports.startServer = startServer;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const express_js_1 = require("@modelcontextprotocol/sdk/server/express.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_1 = require("zod");
const zod_to_json_schema_1 = require("zod-to-json-schema");
const tim_store_1 = require("tim-store");
const project_output_js_1 = require("./project-output.js");
const tim_core_1 = require("tim-core");
const trust_js_1 = require("./trust.js");
const provenance_js_1 = require("./provenance.js");
const task_status_js_1 = require("./task-status.js");
const tim_hooks_1 = require("tim-hooks");
const tim_migrate_1 = require("tim-migrate");
const tim_sync_client_1 = require("tim-sync-client");
const write_validate_js_1 = require("./write-validate.js");
const remember_handler_js_1 = require("./remember-handler.js");
const session_guidance_js_1 = require("./session-guidance.js");
const auto_init_js_1 = require("./auto-init.js");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/**
 * Format a tool response payload to JSON.
 * Uses compact format (no whitespace) for payloads over COMPACT_THRESHOLD bytes
 * to reduce MCP transport overhead. Smaller payloads use pretty-print for readability.
 */
const COMPACT_THRESHOLD = 50_000; // 50KB — compact above this
function formatToolResponse(payload) {
    // Build compact first (cheap), then prettify only if small
    const compact = JSON.stringify(payload);
    if (compact.length <= COMPACT_THRESHOLD) {
        return JSON.stringify(payload, null, 2);
    }
    return compact;
}
// ─── CLI ────────────────────────────────────────────────
function parseCliArgs() {
    const argv = process.argv.slice(2);
    let http = false;
    let port = Number.parseInt(process.env.TIM_MCP_PORT ?? '3847', 10);
    let host = process.env.TIM_MCP_HOST ?? '127.0.0.1';
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--http') {
            http = true;
        }
        else if (arg === '--port') {
            const next = argv[++i];
            if (next)
                port = Number.parseInt(next, 10);
        }
        else if (arg === '--host') {
            const next = argv[++i];
            if (next)
                host = next;
        }
    }
    return { http, port, host };
}
const CLI = parseCliArgs();
// ─── Tool Schemas ───────────────────────────────────────
const TimReadSchemaBase = zod_1.z.object({
    id: zod_1.z.union([
        zod_1.z.string(),
        zod_1.z.array(zod_1.z.string().min(1)).min(1).max(50),
    ]).optional()
        .describe('Entry ID (ULID), or array of IDs for batch read (max 50)'),
    project: zod_1.z.string().optional().describe('Project label/alias/name (auto-resolved)'),
    section: zod_1.z.string().optional().describe('Section title — read its children'),
    depth: zod_1.z.number().min(1).max(5).optional().default(2)
        .describe('How many levels to read (1-5)'),
    includeEdges: zod_1.z.boolean().optional().default(false),
    includeChildren: zod_1.z.boolean().optional().default(true).describe('Default true: returns subtree (capped by depth). Set false for parent-only.'),
    showIrrelevant: zod_1.z.boolean().optional().default(false),
    include_body: zod_1.z.boolean().optional().default(false)
        .describe('Return the full content body. Default false — returns summary only (first 500 chars or metadata.summary)'),
});
const TimReadSchema = TimReadSchemaBase.refine(d => d.id !== undefined || d.project !== undefined || d.section !== undefined, { message: 'tim_read requires one of: id, project, section' });
const TimWriteSchema = zod_1.z.object({
    content: zod_1.z.string().describe('Entry body content'),
    title: zod_1.z.string().optional(),
    parentId: zod_1.z.string().optional(),
    parentTitle: zod_1.z.string().optional().describe('Section title; requires projectId'),
    projectId: zod_1.z.string().optional().describe('Project label, e.g. P0062'),
    where: zod_1.z.string().optional()
        .describe('Shorthand P0062/Tasks → project + section parentId (parentId wins)'),
    contentType: zod_1.z.enum(['text', 'json', 'blob']).optional().default('text'),
    confidence: zod_1.z.number().min(0).max(1).optional().default(1.0),
    tags: zod_1.z.array(zod_1.z.string()).optional().default([])
        .describe('Topic tags only (#tim, #security). Status/priority tags (#todo, #done, #priority-*) are deprecated — use metadata.task.status / metadata.task.priority.'),
    visibility: zod_1.z.number().optional().default(1),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional().default({}),
    force: zod_1.z.boolean().optional().default(false)
        .describe('Bypass the near-duplicate title check and write anyway'),
});
const TimSearchSchema = zod_1.z.object({
    query: zod_1.z.string().describe('FTS5 search query'),
    topK: zod_1.z.number().min(1).max(100).optional().default(10),
    searchType: zod_1.z.enum(['fts', 'vector', 'hybrid']).optional().default('fts'),
    root: zod_1.z.string().optional().describe('Scope to project (label/alias/name)'),
    type: zod_1.z.string().optional().describe('Filter metadata.type'),
    tag: zod_1.z.string().optional().describe('Filter exact tag'),
    status: zod_1.z.string().optional().describe('Filter metadata.status'),
});
const TimGuardSchema = zod_1.z.object({
    action: zod_1.z.string().min(3)
        .describe('The planned action, in plain words — e.g. "upload PDF via rmapi"'),
    project: zod_1.z.string().optional()
        .describe('Scope to a project (label/alias/name). Default: all projects'),
    topK: zod_1.z.number().min(1).max(20).optional().default(5),
});
const TimDeltaSchema = zod_1.z.object({
    project: zod_1.z.string().optional()
        .describe('Project label/alias/name. Default: the bound project'),
    since: zod_1.z.string().optional()
        .describe('ISO 8601 cutoff. Default: last activity of the previous session, ' +
        'else 7 days ago'),
});
const TimRememberSchema = zod_1.z.object({
    query: zod_1.z.string().min(1).max(500)
        .describe('Vage Erinnerungs-Query. Mehrere Wortvarianten werden automatisch probiert.'),
    topK: zod_1.z.number().int().min(1).max(20).optional().default(5)
        .describe('Anzahl Rückgabe-Treffer. Default 5, max 20.'),
    minConfidence: zod_1.z.number().min(0).max(1).optional().default(0.3)
        .describe('Treffer unter diesem Confidence werden gefiltert. Default 0.3.'),
    includeBatchSummaries: zod_1.z.boolean().optional().default(true)
        .describe('Session-Batch-Summaries der letzten 30 Tage mit einbeziehen. Default true.'),
    searchType: zod_1.z.enum(['fts']).optional().default('fts')
        .describe('Nur FTS5 in Phase 1.0. "hybrid" ist für Embedding-Phase 0.7+ reserviert.'),
    projectScope: zod_1.z.string().regex(/^P\d{4}$/).optional()
        .describe('Optional: Suche auf ein Projekt beschränken (z.B. "P0062"). Default: alle Projekte.'),
});
const TimLinkSchema = zod_1.z.object({
    sourceId: zod_1.z.string(),
    targetId: zod_1.z.string(),
    type: zod_1.z.enum([
        'relates', 'extends', 'contradicts', 'implements',
        'blocks', 'leases', 'tagged', 'summarizes', 'contradicted_by'
    ]),
    weight: zod_1.z.number().min(0).max(1).optional().default(1.0),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional().default({}),
});
const TimTraceSchema = zod_1.z.object({
    startId: zod_1.z.string(),
    edgeType: zod_1.z.string().optional(),
    depth: zod_1.z.number().min(1).max(20).optional().default(5),
});
const TimUpdateSchema = zod_1.z.object({
    id: zod_1.z.string(),
    title: zod_1.z.string().optional().describe('Update entry title'),
    content: zod_1.z.string().optional(),
    confidence: zod_1.z.number().min(0).max(1).optional(),
    tags: zod_1.z.array(zod_1.z.string()).optional()
        .describe('Topic tags only. Deprecated status/priority tags are stripped — use metadata.task.status / metadata.task.priority.'),
    visibility: zod_1.z.number().optional(),
    irrelevant: zod_1.z.boolean().optional()
        .describe('Set false to restore a soft-deleted entry, true to soft-delete'),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
});
const TimVerifySchema = zod_1.z.object({
    id: zod_1.z.union([zod_1.z.string(), zod_1.z.array(zod_1.z.string()).min(1).max(50)])
        .describe('Entry ID (or label like L0042), or array of up to 50 IDs'),
});
const TimDeleteSchema = zod_1.z.object({
    id: zod_1.z.string(),
    hard: zod_1.z.boolean().optional().default(false),
});
const TimStatsSchema = zod_1.z.object({
    root: zod_1.z.string().optional().describe('Optional project label to scope stats'),
    kind: zod_1.z.string().optional().describe('Optional metadata.kind filter'),
    buckets: zod_1.z.array(zod_1.z.number()).optional().default([0, 100, 500, 1000, 5000, 10000, 50000]),
});
const TimDeleteBatchSchema = zod_1.z.object({
    ids: zod_1.z.array(zod_1.z.string()).min(1).max(100),
    hard: zod_1.z.boolean().default(true),
});
const TimSectionChildrenSchema = zod_1.z.object({
    parentId: zod_1.z.string().optional(),
    parentLabel: zod_1.z.string().optional().describe('Project label, e.g. P0062'),
    sectionTitle: zod_1.z.string().optional().describe('Section title under the project'),
    kind: zod_1.z.string().optional().describe('Optional metadata.kind filter'),
});
const TimSyncSchema = zod_1.z.object({
    action: zod_1.z.enum(['push', 'pull', 'status']),
    stagingRecords: zod_1.z.array(zod_1.z.object({
        key: zod_1.z.string(),
        entityType: zod_1.z.enum(['entry', 'edge']),
        operation: zod_1.z.enum(['upsert', 'delete']),
        payload: zod_1.z.string(),
        lwwTimestamp: zod_1.z.number(),
        lwwDevice: zod_1.z.string(),
        lwwConfidence: zod_1.z.number().optional().default(1.0),
        acked: zod_1.z.boolean().optional().default(false),
    })).optional(),
});
const TimLeaseSchema = zod_1.z.object({
    grant: zod_1.z.string().optional().describe('Agent label to grant access to'),
    revoke: zod_1.z.string().optional().describe('Agent label to revoke access from'),
    entryId: zod_1.z.string(),
    ttl: zod_1.z.string().optional().describe('Duration: 1h, 30m, 7d'),
});
const TimSuppressSchema = zod_1.z.object({
    pattern: zod_1.z.string(),
    reason: zod_1.z.string().optional().default('Manual suppression'),
    ttl: zod_1.z.string().optional(),
});
const TimExportSchema = zod_1.z.object({
    format: zod_1.z.enum(['text', 'hmem', 'md']).optional().default('text'),
    targetPath: zod_1.z.string().optional().describe('Output path (required for hmem format)'),
});
const TimImportSchema = zod_1.z.object({
    source: zod_1.z.string().describe('Path to .hmem file'),
    dryRun: zod_1.z.boolean().optional().default(false),
    deduplicate: zod_1.z.boolean().optional().default(false),
});
const TimDoctorSchema = zod_1.z.object({});
const TimSessionStartSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    projectId: zod_1.z.string().optional().describe('Project label, e.g. P0062'),
    agentName: zod_1.z.string().optional().default('default'),
    cwd: zod_1.z.string().optional(),
    harness: zod_1.z.string().optional().default('mcp'),
    batchSize: zod_1.z.number().min(1).max(50).optional(),
    tool: zod_1.z.string().optional().describe('CLI tool used, e.g. claude, cursor, codex'),
    model: zod_1.z.string().optional().describe('Model name, e.g. opus, composer-2.5'),
    taskSummary: zod_1.z.string().optional().describe('One-line description of what was delegated'),
});
const TimShowUnsummarizedSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
});
const TimWriteBatchSummarySchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    batchIndex: zod_1.z.number().int().positive(),
    summary: zod_1.z.string(),
    seqFrom: zod_1.z.number().int().nonnegative(),
    seqTo: zod_1.z.number().int().nonnegative(),
    tags: zod_1.z.array(zod_1.z.string()).optional(),
});
const TimRollupSessionSummarySchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
});
const TimRecordCommitSchema = zod_1.z.object({
    projectId: zod_1.z.string().describe('Project label, e.g. P0063'),
    hash: zod_1.z.string().describe('Full git commit SHA'),
    message: zod_1.z.string().describe('Commit message body'),
    diffSummary: zod_1.z.string().optional().describe('git show --stat output'),
    sessionId: zod_1.z.string().optional().describe('Session that produced this commit'),
    branch: zod_1.z.string().optional(),
    author: zod_1.z.string().optional(),
    date: zod_1.z.string().optional().describe('ISO 8601 commit date'),
});
const TimSessionLogSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
    entries: zod_1.z.array(zod_1.z.object({
        role: zod_1.z.enum(['user', 'agent']),
        content: zod_1.z.string(),
    })),
});
const TimCheckpointSchema = zod_1.z.object({
    sessionId: zod_1.z.string(),
});
const TimHookPromptSubmitSchema = zod_1.z.object({
    prompt: zod_1.z.string().min(1).describe('User prompt text for hybrid retrieval'),
    project: zod_1.z.string().optional()
        .describe('Scope retrieval/guard to a project label'),
});
const TimRenameEntrySchema = zod_1.z.object({
    oldId: zod_1.z.string().describe('Current entry ID'),
    newId: zod_1.z.string().describe('New entry ID (must not exist)'),
});
const TimMoveEntrySchema = zod_1.z.object({
    id: zod_1.z.string().describe('Entry ID to move'),
    newParentId: zod_1.z.string().nullable().optional().default(null)
        .describe('New parent ID, or null for root'),
    order: zod_1.z.number().optional(),
});
const TimUpdateManySchema = zod_1.z.object({
    ids: zod_1.z.array(zod_1.z.string()).min(1),
    irrelevant: zod_1.z.boolean().optional(),
    favorite: zod_1.z.boolean().optional(),
});
const TimTagAddSchema = zod_1.z.object({
    id: zod_1.z.string(),
    tags: zod_1.z.array(zod_1.z.string()).min(1),
});
const TimTagRemoveSchema = zod_1.z.object({
    id: zod_1.z.string(),
    tags: zod_1.z.array(zod_1.z.string()).min(1),
});
const TimTagRenameSchema = zod_1.z.object({
    oldTag: zod_1.z.string(),
    newTag: zod_1.z.string(),
});
const TimCreateProjectSchema = zod_1.z.object({
    label: zod_1.z.string().describe('Project label, e.g. P0062'),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional().default({}),
    content: zod_1.z.string().optional(),
    aliases: zod_1.z.array(zod_1.z.string()).optional().describe('Short names for tim_load_project, e.g. ["o9k", "hmem"]'),
});
const TimLoadProjectSchema = zod_1.z.object({
    label: zod_1.z.string().describe('Project label, e.g. P0062'),
    depth: zod_1.z.number().min(1).max(5).optional().default(3)
        .describe('How many child levels to load (1-5)'),
    budget: zod_1.z.number().min(1).max(1000).optional().default(200)
        .describe('Max child entries to return'),
    sections: zod_1.z.array(zod_1.z.string()).nullable().optional().default(null)
        .describe('Optional section IDs/labels to filter direct children'),
    sessionId: zod_1.z.string().optional().describe('Harness session id; binds TIM session project_ref on first load only'),
    bind: zod_1.z.boolean().optional().default(true)
        .describe('false = cross-project read without binding the session (replaces tim_read_project)'),
});
const TimReadProjectSchema = zod_1.z.object({
    label: zod_1.z.string().describe('Project label, e.g. P0062'),
    depth: zod_1.z.number().min(1).max(5).optional().default(3)
        .describe('How many child levels to load (1-5)'),
    budget: zod_1.z.number().min(1).max(1000).optional().default(200)
        .describe('Max child entries to return'),
    sections: zod_1.z.array(zod_1.z.string()).nullable().optional().default(null)
        .describe('Optional section IDs/labels to filter direct children'),
});
const TimShowSchema = zod_1.z.object({
    what: zod_1.z.string().describe('tasks|errors|bugs|ideas|decisions|learnings|commits|all|<SectionName>'),
    root: zod_1.z.string().optional().describe('Project label/alias/name; "" or "all" = all projects; omit = active'),
    with: zod_1.z.string().optional().describe('comma-separated AND filters: open,done,urgent,recent,<tagname>,<free text>'),
    limit: zod_1.z.number().min(1).max(100).optional().default(20),
});
const TimErrorStatsSchema = zod_1.z.object({
    hours: zod_1.z.number().min(1).max(720).optional().default(24)
        .describe('Time window in hours (1-720)'),
    limit: zod_1.z.number().min(1).max(100).optional().default(10)
        .describe('Max top errors to return'),
});
const TimErrorLogSchema = zod_1.z.object({
    tool: zod_1.z.string().describe('Tool name, e.g. "summarizer/codex"'),
    error: zod_1.z.string().describe('Error message'),
    stack: zod_1.z.string().optional().describe('Stack trace (optional)'),
    sessionId: zod_1.z.string().optional().describe('Associated session ID (optional)'),
    args: zod_1.z.record(zod_1.z.unknown()).optional().describe('Tool arguments (optional)'),
});
const TimHealthSchema = zod_1.z.object({});
const TimShowAllUnsummarizedSchema = zod_1.z.object({});
const TimShowUntaggedSchema = zod_1.z.object({});
// ─── ListTools registry (single source of truth) ────────
exports.TOOL_DEFS = [
    {
        name: 'tim_read',
        description: 'Read an entry from TIM. Returns entry content, children, and optional edges. ' +
            'id accepts a human label (P0063, L0042, E0007) or an internal entry id — ' +
            'labels are resolved automatically, no need to look up the id first.',
        schema: TimReadSchemaBase,
    },
    {
        name: 'tim_write',
        description: 'Write a NEW entry to TIM (never for editing — use tim_update). ' +
            'Placement: where:"P0063/Ideas" shorthand, or parentId, or parentTitle+projectId. ' +
            'A near-duplicate title in scope returns duplicate_suspected with the existing entry — ' +
            'read it and update instead; pass force:true only when it is genuinely a different thing. ' +
            'Tags are topics (#tim, #security); status/priority belong in metadata.task.',
        schema: TimWriteSchema,
    },
    {
        name: 'tim_search',
        description: 'Search TIM entries using FTS5 full-text search: keywords, "quoted phrases", ' +
            'prefix*. NOT SQL — no column filters. For vague/associative queries use tim_remember; ' +
            'for a known label use tim_read directly.',
        schema: TimSearchSchema,
    },
    {
        name: 'tim_guard',
        description: 'Pre-action check against negative memory: search known ' +
            'failures (kind=error) and learnings (kind=learning) matching a planned ' +
            'action. Call BEFORE risky/expensive actions — returns warnings with ' +
            'entry ids to tim_read, or status "clear".',
        schema: TimGuardSchema,
    },
    {
        name: 'tim_delta',
        description: 'What changed in a project since the previous session ' +
            '(created / updated / deleted entries). Supplement to the full ' +
            'project briefing, not a replacement.',
        schema: TimDeltaSchema,
    },
    {
        name: 'tim_link',
        description: 'Create an edge (relationship) between two entries.',
        schema: TimLinkSchema,
    },
    {
        name: 'tim_trace',
        description: 'Follow an edge chain from a starting entry (BFS traversal).',
        schema: TimTraceSchema,
    },
    {
        name: 'tim_update',
        description: 'Update an existing entry. Only provided fields are changed — but a provided ' +
            'field REPLACES its old value entirely: content replaces the whole body (it does NOT ' +
            'append — tim_read first, merge, then update), metadata replaces the whole metadata ' +
            'object except system-managed fields (verified_at, provenance), which are preserved. ' +
            'For short flips (status, priority) send only the metadata patch, keep content out.',
        schema: TimUpdateSchema,
    },
    {
        name: 'tim_verify',
        description: 'Re-confirm entries as still valid without editing them. Stamps metadata.verified_at — clears the stale annotation on reads and the stale count in tim_health.',
        schema: TimVerifySchema,
    },
    {
        name: 'tim_delete',
        description: 'Delete an entry (soft: mark irrelevant, hard: tombstone).',
        schema: TimDeleteSchema,
    },
    {
        name: 'tim_delete_batch',
        description: 'Batch hard-delete entries by id (max 100). Skips missing ids.',
        schema: TimDeleteBatchSchema,
    },
    {
        name: 'tim_sync',
        description: 'Sync operations: push staging records, pull from remote, or check status.',
        schema: TimSyncSchema,
    },
    {
        name: 'tim_lease',
        description: 'Grant or revoke temporary agent access to a memory entry.',
        schema: TimLeaseSchema,
    },
    {
        name: 'tim_suppress',
        description: 'Suppress entries matching a pattern: hidden from tim_search, tim_read, and tim_load_project. Optional TTL (e.g. "24h", "7d").',
        schema: TimSuppressSchema,
    },
    {
        name: 'tim_health',
        description: 'Run health diagnostics: broken links, orphans, FTS integrity, counts.',
        schema: TimHealthSchema,
    },
    {
        name: 'tim_stats',
        description: 'Content statistics: entry counts, content size aggregates, length buckets, and breakdown by metadata.kind.',
        schema: TimStatsSchema,
    },
    {
        name: 'tim_section_children',
        description: 'List direct children of a project section in compact form.',
        schema: TimSectionChildrenSchema,
    },
    {
        name: 'tim_export',
        description: 'Export TIM database to markdown or .hmem SQLite format.',
        schema: TimExportSchema,
    },
    {
        name: 'tim_import',
        description: 'Import entries from a .hmem SQLite file.',
        schema: TimImportSchema,
    },
    {
        name: 'tim_doctor',
        description: 'Run comprehensive diagnostics: config, DB, API connectivity.',
        schema: TimDoctorSchema,
    },
    {
        name: 'tim_session_start',
        description: 'Start a TIM session (idempotent). With projectId (or default P0000 Inbox), creates nested Sessions/Summary/Exchanges tree. Without a resolvable project the response lists recently active projects — follow its ACTION line to bind one.',
        schema: TimSessionStartSchema,
    },
    {
        name: 'tim_session_log',
        description: 'Append exchange entries to a session log.',
        schema: TimSessionLogSchema,
        internal: true,
    },
    {
        name: 'tim_show_unsummarized',
        description: 'Return the next unsummarized batch of exchanges for a session (UUIDs + user/agent bodies). Summarizer reads this, writes a Batch node under Summary.',
        schema: TimShowUnsummarizedSchema,
        internal: true,
    },
    {
        name: 'tim_show_all_unsummarized',
        description: 'Scan ALL sessions and return every unsummarized batch. Use at startup for cleanup sweep of stale batches (crashed summarizer, missed triggers). No parameters needed.',
        schema: TimShowAllUnsummarizedSchema,
        internal: true,
    },
    {
        name: 'tim_show_untagged',
        description: 'Return batch-summary nodes that have only structural tags (#session-summary, #batch-summary) and no content hashtags. Use for re-tagging failed or legacy summaries.',
        schema: TimShowUntaggedSchema,
        internal: true,
    },
    {
        name: 'tim_write_batch_summary',
        description: 'Write an idempotent Batch summary node under the session Summary tree. Used by tim-summarizer CLI.',
        schema: TimWriteBatchSummarySchema,
        internal: true,
    },
    {
        name: 'tim_rollup_session_summary',
        description: 'Fold batch-summary children into the session-summary-root content field. Called after tim-summarizer writes all batches.',
        schema: TimRollupSessionSummarySchema,
        internal: true,
    },
    {
        name: 'tim_record_commit',
        description: 'Record a git commit under the project Commits section. Idempotent by hash. Links to session via relates/implements when sessionId given.',
        schema: TimRecordCommitSchema,
    },
    {
        name: 'tim_checkpoint',
        description: 'Create a session checkpoint summary and run verify-before-decay.',
        schema: TimCheckpointSchema,
        internal: true,
    },
    {
        name: 'tim_hook_prompt_submit',
        description: 'UserPromptSubmit hook: FTS retrieval (top-3) + guard warnings for action-like prompts. ' +
            'Returns context lines for harness injection. Kill-switch: hooks.promptSubmit.enabled.',
        schema: TimHookPromptSubmitSchema,
        internal: true,
    },
    {
        name: 'tim_rename_entry',
        description: 'Atomically rename an entry ID and update all references (edges, parent_id, staging, metadata).',
        schema: TimRenameEntrySchema,
    },
    {
        name: 'tim_move_entry',
        description: 'Move an entry under a new parent and cascade depth updates to descendants.',
        schema: TimMoveEntrySchema,
    },
    {
        name: 'tim_update_many',
        description: 'Batch-update irrelevant and/or favorite flags on multiple entries (flags only, never content).',
        schema: TimUpdateManySchema,
    },
    {
        name: 'tim_tag_add',
        description: 'Add tags to an entry (deduplicated). Deprecated status/priority tags (#todo, #done, #priority-*) are skipped — use metadata.task.status / metadata.task.priority.',
        schema: TimTagAddSchema,
    },
    {
        name: 'tim_tag_remove',
        description: 'Remove tags from an entry.',
        schema: TimTagRemoveSchema,
    },
    {
        name: 'tim_tag_rename',
        description: 'Rename a tag across all entries (exact match only, safe for substring collisions).',
        schema: TimTagRenameSchema,
    },
    {
        name: 'tim_create_project',
        description: 'Register a project entry so load_project can find it later.',
        schema: TimCreateProjectSchema,
    },
    {
        name: 'tim_load_project',
        description: 'Load a project by label or alias and bind the session once. Rejects a different project if the session is already bound — pass bind:false for cross-project reads (replaces tim_read_project).',
        schema: TimLoadProjectSchema,
    },
    {
        name: 'tim_read_project',
        description: '[DEPRECATED — use tim_load_project with bind:false] Read a project brief + tree WITHOUT binding the session (cross-project lookup). Use tim_load_project to start working on a project.',
        schema: TimReadProjectSchema,
    },
    {
        name: 'tim_show',
        description: 'Unified overview: tasks, errors, bugs, ideas, decisions, learnings, commits, sections, or all. ' +
            'Use root for project scope (omit=active, "all"=cross-project). ' +
            'Use with for comma-separated AND filters (open,done,urgent,recent,<tag>,<free text>).',
        schema: TimShowSchema,
    },
    {
        name: 'tim_error_stats',
        description: 'Show error statistics: total errors, top errors, error rate, alert thresholds (>5 identical errors in 1h).',
        schema: TimErrorStatsSchema,
    },
    {
        name: 'tim_error_log',
        description: 'Log an error entry. Used by CLI tools and summarizer for structured error tracking.',
        schema: TimErrorLogSchema,
        internal: true,
    },
    {
        name: 'tim_remember',
        description: 'Associative memory recall for vague queries. Expands query variants, FTS5 pre-filters, ' +
            'then CLI-chain rerank. Read-only. Slower and costlier than tim_search — use when exact keywords are unknown.',
        schema: TimRememberSchema,
    },
];
// ─── Project output formatting ──────────────────────────
function loadProjectSchema() {
    const schemaPath = path.join(process.cwd(), 'docs/project-schema.json');
    try {
        if (fs.existsSync(schemaPath)) {
            return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        }
    }
    catch {
        // schema optional
    }
    return undefined;
}
function truncText(s, max) {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t.length <= max)
        return t;
    return t.slice(0, max - 3) + '...';
}
function summarizeEntry(entry, includeBody) {
    const summary = typeof entry.metadata.summary === 'string' && entry.metadata.summary
        ? entry.metadata.summary
        : truncText(entry.content, 500);
    if (includeBody) {
        return { ...entry, summary };
    }
    const { content, ...rest } = entry;
    return { ...rest, summary };
}
function parseProjectContent(entry) {
    const combined = entry.content ? `${entry.title}\n${entry.content}` : entry.title;
    const parts = combined.split('|').map(p => p.trim());
    const title = parts[0] || entry.title || combined;
    const status = parts[1] || 'Unknown';
    const rest = parts.length > 3 ? parts.slice(3).join(' | ') : parts.slice(1).join(' | ');
    const packagesMatch = combined.match(/(\d+)[-\s]Package/i);
    const testsMatch = combined.match(/\((\d+)\s+tests?\)/i) ?? combined.match(/\b(\d+)\s+tests?\b/i);
    return {
        title,
        status,
        description: truncText(rest || combined, 150),
        packages: packagesMatch ? parseInt(packagesMatch[1], 10) : undefined,
        tests: testsMatch ? parseInt(testsMatch[1], 10) : undefined,
    };
}
const TASK_STATUS_ORDER = {
    in_progress: 0,
    todo: 1,
};
const TASK_PRIORITY_ORDER = {
    high: 0,
    medium: 1,
    low: 2,
};
function sortTaskRecords(tasks) {
    return [...tasks].sort((a, b) => {
        const statusA = TASK_STATUS_ORDER[a.status ?? ''] ?? 2;
        const statusB = TASK_STATUS_ORDER[b.status ?? ''] ?? 2;
        if (statusA !== statusB)
            return statusA - statusB;
        const priorityA = TASK_PRIORITY_ORDER[a.priority ?? ''] ?? 3;
        const priorityB = TASK_PRIORITY_ORDER[b.priority ?? ''] ?? 3;
        if (priorityA !== priorityB)
            return priorityA - priorityB;
        if (!a.due && !b.due)
            return 0;
        if (!a.due)
            return 1;
        if (!b.due)
            return -1;
        return a.due.localeCompare(b.due);
    });
}
function taskStatusIcon(status) {
    switch (status) {
        case 'in_progress': return '[!]';
        case 'done': return '[x]';
        case 'cancelled': return '[-]';
        default: return '[ ]';
    }
}
function taskPriorityLabel(priority) {
    switch (priority) {
        case 'high': return 'HIGH';
        case 'medium': return 'MED';
        case 'low': return 'LOW';
        default: return '';
    }
}
function isTaskOverdue(due, status) {
    if (!due || status === 'done' || status === 'cancelled')
        return false;
    const today = new Date().toISOString().slice(0, 10);
    return due < today;
}
function formatTaskLine(task) {
    const icon = taskStatusIcon(task.status);
    const priority = taskPriorityLabel(task.priority);
    const priorityPart = priority ? `[${priority}]` : '';
    const duePart = task.due ? `[due: ${task.due}]` : '';
    const overdue = isTaskOverdue(task.due, task.status) ? '[OVERDUE] ' : '';
    const statusSuffix = task.status ? ` (${task.status})` : '';
    const meta = [icon, priorityPart, duePart].filter(Boolean).join(' ');
    return `  ${overdue}${meta} ${task.title}${statusSuffix}`;
}
async function formatTasksOutput(store, tasks) {
    const grouped = new Map();
    for (const task of tasks) {
        const key = task.project_label ?? '(no project)';
        const list = grouped.get(key) ?? [];
        list.push(task);
        grouped.set(key, list);
    }
    const projectLabels = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
    const projectCount = projectLabels.filter(l => l !== '(no project)').length;
    const lines = [
        `=== TASKS (${tasks.length} open across ${projectCount} projects) ===`,
        '',
    ];
    for (const label of projectLabels) {
        const groupTasks = sortTaskRecords(grouped.get(label));
        let header = label;
        if (label !== '(no project)') {
            const project = await store.read(label);
            if (project) {
                const parsed = parseProjectContent(project);
                header = `${label} — ${parsed.title}`;
            }
        }
        lines.push(header);
        for (const task of groupTasks) {
            lines.push(formatTaskLine(task));
        }
        lines.push('');
    }
    lines.push('Status legend: [!] = in_progress, [ ] = todo, [x] = done, [-] = cancelled');
    return lines.join('\n').trimEnd();
}
async function resolveRoots(store, root) {
    if (root === undefined) {
        if (!transportIsHttp) {
            const marker = (0, tim_hooks_1.findMarker)(process.cwd(), { walkUp: true });
            if (marker)
                return { labels: [marker.marker.project] };
        }
        const active = (0, tim_hooks_1.getActiveProjectLabel)();
        if (active)
            return { labels: [active] };
        return { error: 'no active project; pass root explicitly or "all"' };
    }
    if (root === '' || root.toLowerCase() === 'all') {
        const projects = await store.listProjects();
        return { labels: projects.map(p => p.label) };
    }
    const r = await store.resolveProjectLabel(root);
    if (r.status === 'found')
        return { labels: [r.label] };
    if (r.status === 'ambiguous') {
        return { error: `ambiguous: ${r.labels.join(', ')}` };
    }
    const needle = root.toLowerCase();
    const hits = (await store.listProjects()).filter(p => p.title.toLowerCase().includes(needle));
    if (hits.length === 1)
        return { labels: [hits[0].label] };
    if (hits.length > 1) {
        return { error: `ambiguous name: ${hits.map(h => h.label).join(', ')}` };
    }
    return { error: `root not found: ${root}` };
}
function dedupeById(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
        if (seen.has(e.id))
            continue;
        seen.add(e.id);
        out.push(e);
    }
    return out;
}
function scopeEntries(store, entries, labels) {
    return entries.filter(e => {
        const label = store.getProjectLabel(e.id);
        return label != null && labels.includes(label);
    });
}
async function sectionChildren(store, name, labels) {
    const result = [];
    for (const label of labels) {
        const resolved = await store.resolveProjectLabel(label);
        if (resolved.status !== 'found')
            continue;
        const project = await store.read(resolved.label);
        if (!project)
            continue;
        const sec = await store.resolveSectionByTitle(project.id, name);
        if (sec.status === 'found') {
            result.push(...await store.getChildren(sec.id));
        }
        else if (sec.status === 'ambiguous') {
            for (const cand of sec.candidates) {
                result.push(...await store.getChildren(cand.id));
            }
        }
    }
    return result;
}
async function allSectionChildren(store, labels) {
    const result = [];
    for (const label of labels) {
        const resolved = await store.resolveProjectLabel(label);
        if (resolved.status !== 'found')
            continue;
        const project = await store.read(resolved.label);
        if (!project)
            continue;
        const sections = await store.getChildren(project.id);
        for (const section of sections) {
            result.push(...await store.getChildren(section.id));
        }
    }
    return result;
}
async function fetchByWhat(store, what, labels) {
    const lc = what.toLowerCase();
    switch (lc) {
        case 'tasks': {
            const rows = await store.getTasks();
            const scoped = rows.filter(r => r.project_label != null && labels.includes(r.project_label));
            const entries = [];
            for (const row of scoped) {
                const e = await store.read(row.id);
                if (e)
                    entries.push(e);
            }
            return entries;
        }
        case 'errors': {
            const a = await store.getByMetadataType('error');
            const b = await store.getByTag('#error');
            return scopeEntries(store, dedupeById([...a, ...b]), labels);
        }
        case 'bugs':
            return scopeEntries(store, await store.getByTag('#bug'), labels);
        case 'decisions':
            return scopeEntries(store, await store.getByTag('#decision'), labels);
        case 'learnings':
            return scopeEntries(store, await store.getByTag('#learning'), labels);
        case 'commits':
            return scopeEntries(store, await store.getByMetadataKind('commit', 1000), labels);
        case 'ideas':
            return sectionChildren(store, 'Ideas', labels);
        case 'all':
            return allSectionChildren(store, labels);
        default:
            return sectionChildren(store, what, labels);
    }
}
const SHOW_STATUS_ORDER = {
    in_progress: 0,
    todo: 1,
};
const SHOW_PRIORITY_ORDER = {
    high: 0,
    medium: 1,
    low: 2,
};
function resolveEntryTaskPriority(metadata) {
    const task = metadata.task;
    if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
        const pr = task.priority;
        if (typeof pr === 'string')
            return pr;
    }
    const pr = metadata.priority;
    return typeof pr === 'string' ? pr : undefined;
}
async function applyWith(store, entries, withStr) {
    if (!withStr)
        return entries;
    const terms = withStr.split(',').map(t => t.trim()).filter(Boolean);
    let result = entries;
    const ftsTerms = [];
    for (const t of terms) {
        const lc = t.toLowerCase();
        switch (lc) {
            case 'open':
                result = result.filter(e => {
                    const st = (0, task_status_js_1.resolveEntryTaskStatus)(e.metadata);
                    return st !== 'done' && st !== 'cancelled';
                });
                break;
            case 'done':
                result = result.filter(e => (0, task_status_js_1.resolveEntryTaskStatus)(e.metadata) === 'done');
                break;
            case 'urgent':
                result = result.filter(e => e.tags.includes('#urgent'));
                break;
            case 'recent': {
                const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
                result = result.filter(e => Date.parse(e.createdAt) >= cutoff);
                break;
            }
            default: {
                const tagForm = t.startsWith('#') ? t : `#${t}`;
                if (result.some(e => e.tags.includes(tagForm) || e.tags.includes(t))) {
                    result = result.filter(e => e.tags.includes(tagForm) || e.tags.includes(t));
                }
                else {
                    ftsTerms.push(t);
                }
                break;
            }
        }
    }
    if (ftsTerms.length > 0) {
        const hitIds = new Set();
        for (const q of ftsTerms) {
            const hits = await store.searchFts(q, 1000);
            for (const e of hits)
                hitIds.add(e.id);
        }
        result = result.filter(e => hitIds.has(e.id));
    }
    return result;
}
function sortForShow(entries) {
    return [...entries].sort((a, b) => {
        const statusA = SHOW_STATUS_ORDER[(0, task_status_js_1.resolveEntryTaskStatus)(a.metadata) ?? ''] ?? 2;
        const statusB = SHOW_STATUS_ORDER[(0, task_status_js_1.resolveEntryTaskStatus)(b.metadata) ?? ''] ?? 2;
        if (statusA !== statusB)
            return statusA - statusB;
        const priorityA = SHOW_PRIORITY_ORDER[resolveEntryTaskPriority(a.metadata) ?? ''] ?? 3;
        const priorityB = SHOW_PRIORITY_ORDER[resolveEntryTaskPriority(b.metadata) ?? ''] ?? 3;
        if (priorityA !== priorityB)
            return priorityA - priorityB;
        return b.createdAt.localeCompare(a.createdAt);
    });
}
function formatShowLine(entry) {
    const icon = taskStatusIcon((0, task_status_js_1.resolveEntryTaskStatus)(entry.metadata) ?? null);
    const title = entry.title.padEnd(44, ' ');
    const tagStr = entry.tags.join(' ');
    return `  ${icon} ${title}${tagStr ? ' ' + tagStr : ''}`.trimEnd();
}
async function formatShowOutput(store, entries) {
    const grouped = new Map();
    for (const entry of entries) {
        const label = store.getProjectLabel(entry.id) ?? '(no project)';
        const list = grouped.get(label) ?? [];
        list.push(entry);
        grouped.set(label, list);
    }
    const projectLabels = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
    const lines = [];
    for (const label of projectLabels) {
        const groupEntries = sortForShow(grouped.get(label));
        let header = label;
        if (label !== '(no project)') {
            const project = await store.read(label);
            if (project) {
                const parsed = parseProjectContent(project);
                header = `${label} — ${parsed.title}`;
            }
        }
        lines.push(header);
        for (const entry of groupEntries) {
            lines.push(formatShowLine(entry));
        }
        lines.push('');
    }
    lines.push('[!]=in_progress [ ]=todo [x]=done [-]=cancelled');
    return lines.join('\n').trimEnd();
}
function resolveProjectRef(session) {
    const uid = session.metadata.project_uid ?? session.metadata.projectUid;
    if (typeof uid === 'string' && uid)
        return uid;
    const label = session.metadata.projectLabel ?? session.metadata.project_label;
    if (typeof label === 'string' && label)
        return label;
    return (0, tim_hooks_1.getActiveProjectLabel)();
}
async function buildCortexReadyBlock(store, session) {
    const ref = resolveProjectRef(session);
    if (!ref)
        return null;
    const projectEntry = await store.read(ref);
    if (!projectEntry || projectEntry.metadata.kind !== 'project')
        return null;
    const label = String(projectEntry.metadata.label ?? ref);
    const parsed = parseProjectContent(projectEntry);
    const stats = await store.stats();
    const loadResult = await store.loadProject(label, { depth: 3, budget: 150 });
    const sessionSummaries = (loadResult?.children ?? []).filter(c => c.tags.includes('#session-summary'));
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekIso = weekAgo.toISOString();
    const sessionsThisWeek = sessionSummaries.filter(s => s.createdAt >= weekIso).length;
    const lastDate = sessionSummaries[0]?.createdAt.slice(0, 10) ?? projectEntry.createdAt.slice(0, 10);
    const shortName = parsed.title.split('—')[0]?.trim() || parsed.title;
    const entriesStr = stats.totalEntries.toLocaleString('en-US');
    const metaBits = [parsed.status];
    if (parsed.tests != null)
        metaBits.push(`${parsed.tests} tests`);
    metaBits.push(`${entriesStr} entries`);
    return [
        '[CORTEX READY]',
        `Project: ${shortName} (${label}) — ${metaBits.join(' · ')}`,
        `Last: ${lastDate} · ${sessionsThisWeek} sessions this week`,
        '[/CORTEX READY]',
    ].join('\n');
}
// ─── MCP Server Setup ───────────────────────────────────
const DB_PATH = process.env.TIM_DB_PATH || (0, tim_core_1.loadConfig)().dbPath || process.env.HOME + '/.tim/tim.db';
// ─── DB concurrency (no global PID lockfile) ───────────
// Multiple tim-mcp processes may share one DB safely:
// - SQLite WAL mode: one writer, many readers; journal not blocked across readers
// - tim-store sets synchronous=FULL and busy_timeout for write coordination
// - systemd --user unit runs the single long-lived HTTP daemon (singleton)
// - HTTP/SSE transport (7a733c5) is the cross-process path; stdio is for
//   in-process embedding (e.g. tests, tim-summarizer child processes)
if (!CLI.http) {
    // Binary-write guard: refuse to start if DB is not a valid SQLite file.
    if (!process.env.HERMES_SKIP_DB_GUARD && fs.existsSync(DB_PATH)) {
        try {
            const fd = fs.openSync(DB_PATH, 'r');
            const header = Buffer.alloc(16);
            fs.readSync(fd, header, 0, 16, 0);
            fs.closeSync(fd);
            if (header.toString('utf8', 0, 15) !== 'SQLite format 3') {
                const msg = `FATAL: ${DB_PATH} is not a valid SQLite database (header corruption).\n` +
                    `This can happen from accidental binary edits, disk-full mid-write, or OOM kills.\n` +
                    `To recover: run \'tim restore --list\' to see available snapshots, then \'tim restore\'.\n` +
                    `If you are certain the file is valid, set HERMES_SKIP_DB_GUARD=1 to bypass this check.`;
                console.error(msg);
                process.exit(1);
            }
        }
        catch (e) {
            console.error(`FATAL: cannot read DB header: ${e.message}`);
            if (!process.env.HERMES_SKIP_DB_GUARD)
                process.exit(1);
        }
    }
}
let store;
let sessions;
let commitMgr;
let errorLogger;
function getStore() {
    if (!store) {
        store = new tim_store_1.TimStore(DB_PATH);
    }
    return store;
}
function getErrorLogger() {
    if (!errorLogger) {
        errorLogger = new tim_store_1.ErrorLogger(getStore().getDb());
    }
    return errorLogger;
}
function getCommitManager() {
    if (!commitMgr) {
        commitMgr = new tim_store_1.CommitManager(getStore());
    }
    return commitMgr;
}
function getSessions() {
    if (!sessions) {
        const mgr = new tim_store_1.SessionManager(getStore());
        mgr.setOnBatchFull(({ sessionId }) => {
            void (async () => {
                const session = await getStore().read(sessionId);
                const cwd = typeof session?.metadata.cwd === 'string' ? session.metadata.cwd : undefined;
                if (!cwd)
                    return;
                await (0, tim_hooks_1.maybeSpawnSummarizer)(getStore(), cwd, { batchFull: true });
            })();
        });
        sessions = mgr;
    }
    return sessions;
}
const WRITE_TOOLS = new Set([
    'tim_write', 'tim_update', 'tim_verify', 'tim_delete', 'tim_delete_batch', 'tim_link',
    'tim_session_start', 'tim_session_log', 'tim_checkpoint', 'tim_write_batch_summary',
    'tim_rollup_session_summary',
    'tim_record_commit',
    'tim_rename_entry', 'tim_move_entry', 'tim_update_many',
    'tim_tag_add', 'tim_tag_remove', 'tim_tag_rename', 'tim_import',
    'tim_create_project', 'tim_error_log',
]);
const READ_TOOLS = new Set([
    'tim_read', 'tim_search', 'tim_trace', 'tim_health', 'tim_stats', 'tim_section_children',
    'tim_export', 'tim_doctor', 'tim_sync', 'tim_load_project', 'tim_read_project',
    'tim_show',
    'tim_show_unsummarized', 'tim_show_all_unsummarized', 'tim_show_untagged',
    'tim_hook_prompt_submit',
]);
const REMEMBER_TOOLS = new Set(['tim_remember']);
function scheduleAutoSync(toolName, s) {
    if (WRITE_TOOLS.has(toolName)) {
        void (0, tim_sync_client_1.autoPush)(s);
    }
    else if (READ_TOOLS.has(toolName)) {
        void (0, tim_sync_client_1.autoPull)(s);
    }
}
let processErrorGuardsInstalled = false;
function installProcessErrorGuards() {
    if (processErrorGuardsInstalled)
        return;
    processErrorGuardsInstalled = true;
    process.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        console.error('[tim-mcp] unhandledRejection:', err.stack ?? err.message);
        try {
            getErrorLogger().logError({
                tool: 'mcp-server',
                error: `unhandledRejection: ${err.message}`,
                stack: err.stack,
            });
        }
        catch {
            // ErrorLogger itself failed — stay alive.
        }
    });
    process.on('uncaughtException', (err) => {
        console.error('[tim-mcp] uncaughtException:', err.stack ?? err.message);
        try {
            getErrorLogger().logError({
                tool: 'mcp-server',
                error: `uncaughtException: ${err.message}`,
                stack: err.stack,
            });
        }
        catch {
            // Same as above.
        }
    });
}
/**
 * Module-scope transport flag for helpers that live outside createMcpServer
 * (resolveRoots, usageSessionId). Set once by createMcpServer; false covers
 * the stdio default and any call before server construction.
 */
let transportIsHttp = false;
/**
 * Session identity for usage recording — best-effort, null when the
 * process has no resolvable session (recording is then session-less and
 * can never be marked referenced, which is the correct neutral outcome).
 */
function usageSessionId() {
    try {
        return (0, tim_core_1.resolveActiveSessionId)({
            markerSession: transportIsHttp
                ? undefined
                : (0, tim_hooks_1.findMarker)(process.cwd(), { walkUp: true })?.marker.session,
            useSessionCache: !transportIsHttp,
            useEnv: !transportIsHttp,
        }) ?? null;
    }
    catch {
        return null;
    }
}
/** Telemetry must never fail a user-facing tool response. */
function bestEffortTelemetry(label, fn) {
    try {
        fn();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.debug(`[tim-mcp] ${label} failed:`, msg);
    }
}
async function createMcpServer(options = {}) {
    const isHttp = options.transportMode === 'http';
    transportIsHttp = isHttp;
    try {
        await (0, auto_init_js_1.runAutoInit)({ dbPath: DB_PATH });
    }
    catch {
        // Graceful degradation — server still starts.
    }
    const server = new index_js_1.Server({
        name: 'tim-mcp',
        version: '0.1.0-alpha',
    }, {
        capabilities: {
            tools: {},
        },
    });
    // ─── Tool Registration ──────────────────────────────
    // Consistent error contract: every failure path returns isError:true with a
    // helpful text payload. Replaces the old "null" string and the silent
    // text-only returns that some load/read handlers used to produce.
    const errorResult = (text) => ({
        content: [{ type: 'text', text }],
        isError: true,
    });
    // Plumbing tools called by the summarizer / hooks via MCP — handlers must
    // remain fully functional, but ListTools hides them by default so agents
    // don't see internal-only entries. Set TIM_EXPOSE_INTERNAL_TOOLS=1 to reveal.
    server.setRequestHandler(types_js_1.InitializeRequestSchema, async (request) => {
        try {
            await (0, auto_init_js_1.runAutoInit)({ dbPath: DB_PATH });
        }
        catch {
            // Non-fatal — client still gets a valid initialize response.
        }
        return {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'tim-mcp', version: '0.1.0-alpha' },
        };
    });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
        const rememberEnabled = (0, tim_core_1.loadConfig)().remember?.enabled !== false;
        const defs = rememberEnabled
            ? exports.TOOL_DEFS
            : exports.TOOL_DEFS.filter(d => d.name !== 'tim_remember');
        const allTools = defs.map(def => ({
            name: def.name,
            description: def.description,
            inputSchema: (0, zod_to_json_schema_1.zodToJsonSchema)(def.schema, { target: 'openApi3' }),
            internal: def.internal,
        }));
        const exposeInternal = process.env.TIM_EXPOSE_INTERNAL_TOOLS === '1';
        const tools = exposeInternal ? allTools : allTools.filter(t => !t.internal);
        return { tools };
    });
    // ─── Tool Handler ────────────────────────────────────
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const s = getStore();
        const { name, arguments: args } = request.params;
        scheduleAutoSync(name, s);
        try {
            switch (name) {
                case 'tim_read': {
                    const { id, project, section, depth, includeEdges, includeChildren, showIrrelevant, include_body, } = TimReadSchema.parse(args);
                    const readOpts = { depth, includeChildren, showIrrelevant };
                    if (Array.isArray(id)) {
                        let projectLabel = null;
                        if (project) {
                            const pr = await s.resolveProjectLabel(project);
                            if (pr.status === 'ambiguous') {
                                return {
                                    content: [{ type: 'text', text: `ambiguous project: ${pr.labels.join(', ')}` }],
                                    isError: true,
                                };
                            }
                            if (pr.status !== 'found') {
                                return {
                                    content: [{ type: 'text', text: `project not found: ${project}` }],
                                    isError: true,
                                };
                            }
                            projectLabel = pr.label;
                        }
                        const entries = [];
                        const missing = [];
                        for (const entryId of id) {
                            const entry = await s.read(entryId, readOpts);
                            if (!entry) {
                                missing.push(entryId);
                                continue;
                            }
                            if (projectLabel && s.getProjectLabel(entry.id) !== projectLabel) {
                                missing.push(entryId);
                                continue;
                            }
                            entries.push(entry);
                        }
                        bestEffortTelemetry('recordRead', () => s.recordRead(entries.map(e => e.id), usageSessionId()));
                        return {
                            content: [{ type: 'text', text: formatToolResponse({
                                        entries: entries.map(e => summarizeEntry((0, trust_js_1.annotateTrust)(e, isHttp ? '' : process.cwd()), include_body)),
                                        missing,
                                    }) }],
                        };
                    }
                    if (section) {
                        let projectLabel = project;
                        if (!projectLabel) {
                            const roots = await resolveRoots(s, undefined);
                            if (roots.error) {
                                return {
                                    content: [{ type: 'text', text: roots.error }],
                                    isError: true,
                                };
                            }
                            if (roots.labels.length !== 1) {
                                return {
                                    content: [{
                                            type: 'text',
                                            text: 'section read requires a single project (pass project or bind one)',
                                        }],
                                    isError: true,
                                };
                            }
                            projectLabel = roots.labels[0];
                        }
                        const pr = await s.resolveProjectLabel(projectLabel);
                        if (pr.status !== 'found') {
                            return {
                                content: [{ type: 'text', text: `project not found: ${projectLabel}` }],
                                isError: true,
                            };
                        }
                        const projEntry = await s.read(pr.label);
                        if (!projEntry) {
                            return {
                                content: [{ type: 'text', text: `project not found: ${projectLabel}` }],
                                isError: true,
                            };
                        }
                        const sec = await s.resolveSectionByTitle(projEntry.id, section);
                        if (sec.status === 'ambiguous') {
                            return {
                                content: [{
                                        type: 'text',
                                        text: `ambiguous section '${section}': ${sec.candidates.map(c => c.id).join(', ')}`,
                                    }],
                                isError: true,
                            };
                        }
                        if (sec.status !== 'found') {
                            return {
                                content: [{
                                        type: 'text',
                                        text: `section not found: ${section} (candidates: ${sec.candidates.join(', ')})`,
                                    }],
                                isError: true,
                            };
                        }
                        const sectionEntry = await s.read(sec.id, readOpts);
                        const children = await s.getChildren(sec.id);
                        return {
                            content: [{
                                    type: 'text',
                                    text: formatToolResponse({ section: sectionEntry, children }),
                                }],
                        };
                    }
                    if (project && id === undefined) {
                        const pr = await s.resolveProjectLabel(project);
                        if (pr.status === 'ambiguous') {
                            return {
                                content: [{ type: 'text', text: `ambiguous project: ${pr.labels.join(', ')}` }],
                                isError: true,
                            };
                        }
                        if (pr.status !== 'found') {
                            return {
                                content: [{ type: 'text', text: `project not found: ${project}` }],
                                isError: true,
                            };
                        }
                        const entry = await s.read(pr.label, readOpts);
                        if (!entry) {
                            return errorResult(`Project not found: ${project}`);
                        }
                        const edges = includeEdges ? await s.getEdges(entry.id, 'both') : [];
                        bestEffortTelemetry('recordRead', () => s.recordRead([entry.id], usageSessionId()));
                        return {
                            content: [{ type: 'text', text: formatToolResponse({
                                        entry: summarizeEntry((0, trust_js_1.annotateTrust)(entry, isHttp ? '' : process.cwd()), include_body),
                                        edges,
                                    }) }],
                        };
                    }
                    if (typeof id === 'string') {
                        let projectLabel = null;
                        if (project) {
                            const pr = await s.resolveProjectLabel(project);
                            if (pr.status === 'ambiguous') {
                                return {
                                    content: [{ type: 'text', text: `ambiguous project: ${pr.labels.join(', ')}` }],
                                    isError: true,
                                };
                            }
                            if (pr.status !== 'found') {
                                return {
                                    content: [{ type: 'text', text: `project not found: ${project}` }],
                                    isError: true,
                                };
                            }
                            projectLabel = pr.label;
                        }
                        const entry = await s.read(id, readOpts);
                        if (!entry) {
                            return errorResult(`Entry not found: ${id}`);
                        }
                        if (entry && await s.isSuppressed(`${entry.title}\n${entry.content}`)) {
                            return {
                                content: [{ type: 'text', text: `Entry suppressed: ${id}` }],
                                isError: true,
                            };
                        }
                        if (projectLabel && s.getProjectLabel(entry.id) !== projectLabel) {
                            return errorResult(`Entry ${id} not found in project ${projectLabel}`);
                        }
                        const edges = includeEdges ? await s.getEdges(id, 'both') : [];
                        bestEffortTelemetry('recordRead', () => s.recordRead([entry.id], usageSessionId()));
                        return {
                            content: [{ type: 'text', text: formatToolResponse({
                                        entry: summarizeEntry((0, trust_js_1.annotateTrust)(entry, isHttp ? '' : process.cwd()), include_body),
                                        edges,
                                    }) }],
                        };
                    }
                    return {
                        content: [{ type: 'text', text: 'tim_read requires one of: id, project, section' }],
                        isError: true,
                    };
                }
                case 'tim_write': {
                    const opts = TimWriteSchema.parse(args);
                    const { parentTitle, projectId, where, force, ...writeOpts } = opts;
                    if (!writeOpts.parentId && where) {
                        const parts = where.split('/');
                        const projPart = parts[0]?.trim();
                        const secPart = parts.slice(1).join('/').trim();
                        if (!projPart || !secPart) {
                            return {
                                content: [{
                                        type: 'text',
                                        text: `Invalid where shorthand '${where}' — expected P0062/Tasks`,
                                    }],
                                isError: true,
                            };
                        }
                        const pr = await s.resolveProjectLabel(projPart);
                        if (pr.status === 'ambiguous') {
                            return {
                                content: [{
                                        type: 'text',
                                        text: `ambiguous project in where: ${pr.labels.join(', ')}`,
                                    }],
                                isError: true,
                            };
                        }
                        if (pr.status !== 'found') {
                            return {
                                content: [{ type: 'text', text: `project not found in where: ${projPart}` }],
                                isError: true,
                            };
                        }
                        const projEntry = await s.read(pr.label);
                        if (!projEntry) {
                            return {
                                content: [{ type: 'text', text: `project not found in where: ${projPart}` }],
                                isError: true,
                            };
                        }
                        const sr = await s.resolveSectionByTitle(projEntry.id, secPart);
                        if (sr.status === 'ambiguous') {
                            return {
                                content: [{
                                        type: 'text',
                                        text: `ambiguous section '${secPart}': ${sr.candidates.map(c => `${c.title} (${c.id})`).join(', ')}`,
                                    }],
                                isError: true,
                            };
                        }
                        if (sr.status !== 'found') {
                            return {
                                content: [{
                                        type: 'text',
                                        text: `section not found: ${secPart} (candidates: ${sr.candidates.join(', ')})`,
                                    }],
                                isError: true,
                            };
                        }
                        writeOpts.parentId = sr.id;
                    }
                    if (!writeOpts.parentId && parentTitle) {
                        if (!projectId) {
                            return {
                                content: [{ type: 'text', text: 'projectId required when using parentTitle' }],
                                isError: true,
                            };
                        }
                        const row = s.getDb().prepare(`
              SELECT e.id FROM entries e
              JOIN entries p ON e.parent_id = p.id
              WHERE json_extract(p.metadata, '$.label') = ?
                AND e.title = ?
            `).get(projectId, parentTitle);
                        if (!row) {
                            return {
                                content: [{
                                        type: 'text',
                                        text: `Parent section '${parentTitle}' not found in project '${projectId}'`,
                                    }],
                                isError: true,
                            };
                        }
                        writeOpts.parentId = row.id;
                    }
                    // Enforce tags for non-schema entries. Schema entries (sections,
                    // project roots, sessions, exchanges, batch summaries, commits,
                    // checkpoints) are exempt — everything else is user content and
                    // must carry at least 2 tags for discoverability.
                    let parentKind;
                    if (writeOpts.parentId) {
                        const parent = await s.read(writeOpts.parentId, { includeChildren: false });
                        parentKind = typeof parent?.metadata?.kind === 'string' ? parent.metadata.kind : undefined;
                    }
                    const supplemented = (0, write_validate_js_1.supplementWriteTags)(writeOpts.tags, writeOpts.metadata, parentKind);
                    writeOpts.tags = supplemented.tags;
                    writeOpts.metadata = supplemented.metadata ?? {};
                    const tagWarnings = (0, tim_store_1.validateTagsDeprecated)(writeOpts.tags ?? []);
                    const { clean: cleanWriteTags } = (0, tim_core_1.stripDeprecatedTags)(writeOpts.tags ?? []);
                    writeOpts.tags = cleanWriteTags;
                    const tagsValidation = (0, write_validate_js_1.validateWriteTags)(writeOpts.tags, writeOpts.metadata);
                    if (!tagsValidation.ok) {
                        return {
                            content: [{ type: 'text', text: formatToolResponse(tagsValidation) }],
                            isError: true,
                        };
                    }
                    // Best-effort git provenance: which commit was HEAD when this
                    // knowledge was written. Skipped for schema entries, explicit
                    // provenance, and when disabled via env.
                    const provKind = typeof writeOpts.metadata?.kind === 'string'
                        ? writeOpts.metadata.kind
                        : undefined;
                    if (process.env.TIM_PROVENANCE !== '0' &&
                        writeOpts.metadata.provenance === undefined &&
                        (!provKind || !tim_core_1.SCHEMA_KINDS.has(provKind))) {
                        const prov = (0, provenance_js_1.captureProvenance)(isHttp ? '' : process.cwd());
                        if (prov) {
                            writeOpts.metadata.provenance = {
                                ...prov,
                                captured_at: new Date().toISOString(),
                            };
                        }
                    }
                    // Dedup gate: refuse knowledge writes whose title is nearly
                    // identical to an existing entry in the same project. Schema
                    // kinds (sessions, exchanges, summaries, …) are pipeline writes
                    // and are never blocked.
                    const dedupKind = typeof writeOpts.metadata?.kind === 'string'
                        ? writeOpts.metadata.kind
                        : undefined;
                    if (!force &&
                        process.env.TIM_DEDUP_CHECK !== '0' &&
                        (!dedupKind || !tim_core_1.SCHEMA_KINDS.has(dedupKind))) {
                        const candidateTitle = (writeOpts.title ?? opts.content.split('\n')[0]).trim();
                        const dedupScope = writeOpts.parentId
                            ? (s.getProjectLabel(writeOpts.parentId) ?? null)
                            : null;
                        // Without a resolvable project scope the gate would scan all projects
                        // and false-positive on generic titles ("Setup", "Next Steps", "Log").
                        // Skip the gate; callers can pass force:true for explicit opt-in.
                        if (dedupScope !== null) {
                            const dupes = candidateTitle
                                ? await s.findSimilar(candidateTitle, { projectLabel: dedupScope })
                                : [];
                            if (dupes.length > 0) {
                                return {
                                    content: [{
                                            type: 'text',
                                            text: formatToolResponse({
                                                status: 'duplicate_suspected',
                                                candidates: dupes,
                                                hint: 'A very similar entry already exists. To extend it: tim_read ' +
                                                    'the candidate, merge your text into its body, then tim_update ' +
                                                    '(content replaces, it does not append). Pass force:true only if ' +
                                                    'this is genuinely a different thing.',
                                            }),
                                        }],
                                    isError: true,
                                };
                            }
                        }
                    }
                    const entry = await s.write(opts.content, writeOpts);
                    const usageSid = usageSessionId();
                    if (usageSid) {
                        const readIds = s.getSessionReadIds(usageSid);
                        const cited = readIds.filter(rid => opts.content.includes(rid));
                        if (cited.length > 0) {
                            bestEffortTelemetry('markReferenced', () => s.markReferenced(cited, usageSid));
                        }
                    }
                    const payload = tagWarnings.length > 0 ? { entry, warnings: tagWarnings } : entry;
                    return {
                        content: [{ type: 'text', text: formatToolResponse(payload) }],
                    };
                }
                case 'tim_search': {
                    const { query, topK, root, type, tag, status } = TimSearchSchema.parse(args);
                    const hasFilters = Boolean(root || type || tag || status);
                    let results = await s.search({ query, topK: hasFilters ? 1000 : topK });
                    if (root) {
                        const roots = await resolveRoots(s, root);
                        if (roots.error) {
                            return {
                                content: [{ type: 'text', text: roots.error }],
                                isError: true,
                            };
                        }
                        results = results.filter(r => roots.labels.includes(s.getProjectLabel(r.id) ?? ''));
                    }
                    if (type) {
                        results = results.filter(r => r.metadata.type === type);
                    }
                    if (tag) {
                        const tg = tag.startsWith('#') ? tag : `#${tag}`;
                        results = results.filter(r => r.tags.includes(tg) || r.tags.includes(tag));
                    }
                    if (status) {
                        results = results.filter(r => r.metadata.status === status);
                    }
                    if (hasFilters) {
                        results = results.slice(0, topK);
                    }
                    bestEffortTelemetry('recordRead', () => s.recordRead(results.map(e => e.id), usageSessionId()));
                    return {
                        content: [{ type: 'text', text: formatToolResponse(results) }],
                    };
                }
                case 'tim_guard': {
                    const { action, project, topK } = TimGuardSchema.parse(args);
                    let projectLabel;
                    if (project) {
                        const pr = await s.resolveProjectLabel(project);
                        if (pr.status !== 'found') {
                            return {
                                content: [{ type: 'text', text: `project not found: ${project}` }],
                                isError: true,
                            };
                        }
                        projectLabel = pr.label;
                    }
                    const matches = await s.searchFailures(action, { projectLabel, limit: topK });
                    if (matches.length === 0) {
                        return {
                            content: [{
                                    type: 'text',
                                    text: formatToolResponse({
                                        status: 'clear',
                                        message: 'No known failures or learnings match this action.',
                                    }),
                                }],
                        };
                    }
                    return {
                        content: [{
                                type: 'text',
                                text: formatToolResponse({
                                    status: 'warnings',
                                    matches: matches.map(e => ({
                                        id: e.id,
                                        title: e.title,
                                        kind: e.metadata.kind,
                                        excerpt: e.content.slice(0, 300),
                                    })),
                                    hint: 'Known failures/learnings match this action. tim_read the ids ' +
                                        'for details before proceeding.',
                                }),
                            }],
                    };
                }
                case 'tim_delta': {
                    const { project, since } = TimDeltaSchema.parse(args);
                    const roots = await resolveRoots(s, project);
                    if (roots.error) {
                        return { content: [{ type: 'text', text: roots.error }], isError: true };
                    }
                    if (!roots.labels || roots.labels.length !== 1) {
                        return {
                            content: [{
                                    type: 'text',
                                    text: 'tim_delta requires a single project (pass project or bind one)',
                                }],
                            isError: true,
                        };
                    }
                    const projEntry = await s.read(roots.labels[0], { includeChildren: false });
                    if (!projEntry) {
                        return {
                            content: [{ type: 'text', text: `project not found: ${roots.labels[0]}` }],
                            isError: true,
                        };
                    }
                    let cutoff = since;
                    let baseline = 'explicit since argument';
                    if (!cutoff) {
                        const currentSession = (0, tim_core_1.resolveActiveSessionId)({
                            markerSession: isHttp ? undefined : (0, tim_hooks_1.findMarker)(process.cwd(), { walkUp: true })?.marker.session,
                            useSessionCache: !isHttp,
                            useEnv: !isHttp,
                        });
                        const prev = await s.getPreviousSession(projEntry.id, currentSession ?? null);
                        if (prev) {
                            cutoff = prev.updatedAt;
                            baseline = `previous session ${prev.id} (last activity)`;
                        }
                        else {
                            cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
                            baseline = 'no previous session found — defaulted to 7 days';
                        }
                    }
                    const delta = await s.getChangedSince(projEntry.id, cutoff);
                    const brief = (e) => ({
                        id: e.id,
                        title: e.title,
                        kind: e.metadata.kind ?? null,
                        updatedAt: e.updatedAt,
                    });
                    return {
                        content: [{
                                type: 'text',
                                text: formatToolResponse({
                                    project: roots.labels[0],
                                    since: cutoff,
                                    baseline,
                                    counts: {
                                        created: delta.created.length,
                                        updated: delta.updated.length,
                                        deleted: delta.deleted.length,
                                    },
                                    created: delta.created.map(brief),
                                    updated: delta.updated.map(brief),
                                    deleted: delta.deleted.map(brief),
                                }),
                            }],
                    };
                }
                case 'tim_remember': {
                    const parsed = TimRememberSchema.safeParse(args);
                    if (!parsed.success) {
                        return {
                            content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }],
                            isError: true,
                        };
                    }
                    const result = await (0, remember_handler_js_1.handleTimRemember)(s, parsed.data);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                    };
                }
                case 'tim_link': {
                    const { sourceId, targetId, type, weight, metadata } = TimLinkSchema.parse(args);
                    const edge = await s.link(sourceId, targetId, type, weight, metadata);
                    const refIds = [];
                    for (const raw of [sourceId, targetId]) {
                        const e = await s.read(raw, { includeChildren: false });
                        if (e)
                            refIds.push(e.id);
                    }
                    if (refIds.length > 0) {
                        bestEffortTelemetry('markReferenced', () => s.markReferenced(refIds, usageSessionId()));
                    }
                    return {
                        content: [{ type: 'text', text: formatToolResponse(edge) }],
                    };
                }
                case 'tim_trace': {
                    const { startId, edgeType, depth } = TimTraceSchema.parse(args);
                    const chain = await s.traceChain(startId, edgeType, depth);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(chain) }],
                    };
                }
                case 'tim_update': {
                    const { id, ...patch } = TimUpdateSchema.parse(args);
                    const resolved = await s.read(id, { showIrrelevant: true, includeChildren: false });
                    if (!resolved)
                        return errorResult(`Entry not found: ${id}`);
                    if (patch.tags !== undefined) {
                        const tagWarnings = (0, tim_store_1.validateTagsDeprecated)(patch.tags);
                        const { clean: cleanTags } = (0, tim_core_1.stripDeprecatedTags)(patch.tags);
                        patch.tags = cleanTags;
                        const entry = await s.update(resolved.id, patch);
                        bestEffortTelemetry('markReferenced', () => s.markReferenced([entry.id], usageSessionId()));
                        const payload = tagWarnings.length > 0 ? { entry, warnings: tagWarnings } : entry;
                        return {
                            content: [{ type: 'text', text: formatToolResponse(payload) }],
                        };
                    }
                    const entry = await s.update(resolved.id, patch);
                    bestEffortTelemetry('markReferenced', () => s.markReferenced([entry.id], usageSessionId()));
                    return {
                        content: [{ type: 'text', text: formatToolResponse(entry) }],
                    };
                }
                case 'tim_verify': {
                    const { id } = TimVerifySchema.parse(args);
                    const rawIds = Array.isArray(id) ? id : [id];
                    const resolved = [];
                    const unresolved = [];
                    for (const raw of rawIds) {
                        const entry = await s.read(raw, { showIrrelevant: true, includeChildren: false });
                        if (entry)
                            resolved.push(entry.id);
                        else
                            unresolved.push(raw);
                    }
                    const result = await s.touchVerified(resolved);
                    return {
                        content: [{
                                type: 'text',
                                text: formatToolResponse({
                                    verified: result.verified,
                                    missing: [...unresolved, ...result.missing],
                                }),
                            }],
                    };
                }
                case 'tim_delete': {
                    const { id, hard } = TimDeleteSchema.parse(args);
                    await s.delete(id, hard);
                    return {
                        content: [{ type: 'text', text: `Entry ${id} ${hard ? 'hard-deleted' : 'marked irrelevant'}` }],
                    };
                }
                case 'tim_delete_batch': {
                    const { ids, hard } = TimDeleteBatchSchema.parse(args);
                    const deleted = await s.deleteBatch(ids, hard);
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ deleted }, null, 2) }],
                    };
                }
                case 'tim_sync': {
                    const { action, stagingRecords } = TimSyncSchema.parse(args);
                    switch (action) {
                        case 'push': {
                            if (!stagingRecords?.length) {
                                return { content: [{ type: 'text', text: 'No staging records to push' }] };
                            }
                            await s.applyStaging(stagingRecords.map(r => ({
                                key: r.key,
                                entityType: r.entityType,
                                operation: r.operation,
                                payload: r.payload,
                                lwwTimestamp: r.lwwTimestamp,
                                lwwDevice: r.lwwDevice,
                                lwwConfidence: r.lwwConfidence,
                                acked: r.acked ?? false,
                            })));
                            return { content: [{ type: 'text', text: `Applied ${stagingRecords.length} staging records` }] };
                        }
                        case 'status': {
                            const cursor = await s.getStagingCursor();
                            const pending = await s.getStaging();
                            return {
                                content: [{ type: 'text', text: JSON.stringify({ cursor, pendingCount: pending.length }) }],
                            };
                        }
                        case 'pull': {
                            const config = (0, tim_sync_client_1.loadConfig)();
                            if (!config) {
                                return errorResult('Sync not configured (set TIM_SYNC_PASSPHRASE and tim-sync config)');
                            }
                            // Force re-arm: manual pull bypasses cooldown + in-flight guard
                            (0, tim_sync_client_1.resetSyncCooldowns)();
                            const result = await (0, tim_sync_client_1.autoPull)(s);
                            const cursor = await s.getStagingCursor();
                            return {
                                content: [{ type: 'text', text: JSON.stringify({
                                            pulled: result.pulled ?? 0,
                                            conflicts: result.conflicts ?? 0,
                                            cursor,
                                            timestamp: new Date().toISOString(),
                                        }) }],
                            };
                        }
                        default:
                            return errorResult(`Sync action '${action}' not yet implemented`);
                    }
                }
                case 'tim_lease': {
                    const { grant, revoke, entryId, ttl } = TimLeaseSchema.parse(args);
                    if (grant) {
                        const agents = await s.getAgents();
                        const agent = agents.find(a => a.label === grant);
                        if (!agent)
                            return errorResult(`Agent "${grant}" not registered`);
                        await s.link(entryId, agent.id, 'leases', 1.0, ttl ? { ttl } : {});
                        return { content: [{ type: 'text', text: `Leased entry ${entryId} to ${grant}` + (ttl ? ` (TTL: ${ttl})` : '') }] };
                    }
                    if (revoke) {
                        const edges = await s.getEdges(entryId, 'outgoing');
                        const leaseEdge = edges.find(e => e.type === 'leases');
                        if (leaseEdge) {
                            await s.unlink(leaseEdge.id);
                            return { content: [{ type: 'text', text: `Revoked lease on ${entryId}` }] };
                        }
                        return { content: [{ type: 'text', text: `No active lease found for ${entryId}` }] };
                    }
                    return errorResult('Specify grant= or revoke=');
                }
                case 'tim_suppress': {
                    const { pattern, reason, ttl } = TimSuppressSchema.parse(args);
                    await s.suppress(pattern, reason, ttl);
                    return {
                        content: [{ type: 'text', text: `Suppressed pattern "${pattern}"` + (ttl ? ` until ${ttl}` : '') }],
                    };
                }
                case 'tim_health': {
                    const report = await s.health();
                    return {
                        content: [{ type: 'text', text: formatToolResponse(report) }],
                    };
                }
                case 'tim_stats': {
                    const { root, kind, buckets } = TimStatsSchema.parse(args);
                    const stats = await s.getContentStats(root, kind, buckets);
                    const maxTokens = (0, tim_hooks_1.getBriefingMaxTokens)((0, tim_core_1.loadConfig)());
                    const scopedEstimate = root
                        ? await (0, tim_store_1.estimateProjectTokens)(s, root, maxTokens)
                        : null;
                    const projectEstimates = root
                        ? (scopedEstimate ? [scopedEstimate] : [])
                        : await (0, tim_store_1.listProjectTokenEstimates)(s, maxTokens);
                    const payload = {
                        ...stats,
                        tokenBudget: {
                            maxTokens,
                            briefingMaxTokens: maxTokens,
                            projectEstimates,
                            scopedEstimate,
                            overBudgetProjects: projectEstimates.filter(p => p.overBriefingBudget).map(p => p.label),
                        },
                    };
                    return {
                        content: [{ type: 'text', text: formatToolResponse(payload) }],
                    };
                }
                case 'tim_section_children': {
                    const { parentId, parentLabel, sectionTitle, kind } = TimSectionChildrenSchema.parse(args);
                    let resolvedParentId = parentId;
                    if (!resolvedParentId) {
                        if (!parentLabel || !sectionTitle) {
                            throw new Error('parentId or (parentLabel + sectionTitle) required');
                        }
                        const section = await s.resolveSectionByTitle(parentLabel, sectionTitle);
                        if (section.status !== 'found') {
                            return {
                                content: [{
                                        type: 'text',
                                        text: JSON.stringify({ parentTitle: sectionTitle, children: [], count: 0 }, null, 2),
                                    }],
                            };
                        }
                        resolvedParentId = section.id;
                    }
                    const parent = await s.read(resolvedParentId, { includeChildren: false });
                    if (!parent) {
                        return {
                            content: [{
                                    type: 'text',
                                    text: JSON.stringify({ parentTitle: sectionTitle ?? '', children: [], count: 0 }, null, 2),
                                }],
                        };
                    }
                    const children = await s.getChildren(resolvedParentId, kind ? { metadataKind: kind } : undefined);
                    const compact = children.map(child => ({
                        id: child.id,
                        title: child.title,
                        kind: typeof child.metadata.kind === 'string' ? child.metadata.kind : '',
                        size: child.content.length,
                    }));
                    return {
                        content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    parentTitle: parent.title,
                                    children: compact,
                                    count: compact.length,
                                }, null, 2),
                            }],
                    };
                }
                case 'tim_export': {
                    const { format, targetPath } = TimExportSchema.parse(args);
                    const exportFormat = format === 'md' ? 'text' : format;
                    if (exportFormat === 'text') {
                        const md = (0, tim_migrate_1.tim_export)(s, undefined, { format: 'text' });
                        return { content: [{ type: 'text', text: md }] };
                    }
                    const outPath = targetPath ?? path.join(os.tmpdir(), `tim-export-${Date.now()}.hmem`);
                    const result = (0, tim_migrate_1.tim_export)(s, outPath, { format: 'hmem' });
                    return {
                        content: [{ type: 'text', text: formatToolResponse(result) }],
                    };
                }
                case 'tim_import': {
                    const { source, dryRun, deduplicate } = TimImportSchema.parse(args);
                    if (!fs.existsSync(source)) {
                        return errorResult(`Source not found: ${source}`);
                    }
                    const report = (0, tim_migrate_1.tim_import)(s, source, { dryRun, deduplicate });
                    return { content: [{ type: 'text', text: formatToolResponse(report) }] };
                }
                case 'tim_doctor': {
                    const report = await s.health();
                    const stats = await s.stats();
                    const agents = await s.getAgents();
                    const errorStats = getErrorLogger().getStats({ hours: 24, limit: 5 });
                    const text = [
                        `TIM Doctor — ${DB_PATH}`,
                        `Entries: ${stats.totalEntries} | Edges: ${stats.totalEdges}`,
                        `Broken links: ${report.brokenLinks} | Orphans: ${report.orphanEntries}`,
                        `FTS5: ${report.ftsIntegrity ? 'OK' : 'BROKEN'}`,
                        `Agents registered: ${agents.length}`,
                        `Errors (24h): ${errorStats.totalErrors} | Rate: ${errorStats.errorRate}/h`,
                        errorStats.alerts.length > 0 ? `⚠ Alerts: ${errorStats.alerts.join('; ')}` : null,
                        ...report.issues.map(i => `⚠ ${i}`),
                    ].filter(Boolean).join('\n');
                    return { content: [{ type: 'text', text }] };
                }
                case 'tim_session_start': {
                    const { sessionId, projectId, agentName, cwd, harness, batchSize, tool, model, taskSummary } = TimSessionStartSchema.parse(args);
                    const cwdResolved = cwd ?? (isHttp ? '' : process.cwd());
                    let boundProjectId = projectId ?? (0, tim_hooks_1.getActiveProjectLabel)() ?? undefined;
                    let inboxFallback = false;
                    if (!boundProjectId) {
                        await (0, tim_store_1.ensureInboxProject)(s);
                        boundProjectId = tim_store_1.INBOX_PROJECT_LABEL;
                        inboxFallback = true;
                    }
                    const entry = await getSessions().startProjectSession({
                        sessionId,
                        projectId: boundProjectId,
                        agentName,
                        cwd: cwdResolved,
                        harness,
                        batchSize,
                        tool,
                        model,
                        taskSummary,
                    });
                    const cortex = await buildCortexReadyBlock(s, entry);
                    let text = cortex
                        ? `${cortex}\n\n${formatToolResponse(entry)}`
                        : formatToolResponse(entry);
                    if (inboxFallback) {
                        const guidance = await (0, session_guidance_js_1.buildInboxFallbackGuidance)(s);
                        if (guidance)
                            text = `${guidance}\n\n${text}`;
                    }
                    return {
                        content: [{ type: 'text', text }],
                    };
                }
                case 'tim_session_log': {
                    const { sessionId, entries } = TimSessionLogSchema.parse(args);
                    const sessionEntry = await s.read(sessionId);
                    const isProjectBound = !!(sessionEntry && (await s.getChildByKind(sessionId, 'exchanges-root')).length > 0);
                    const written = isProjectBound
                        ? await getSessions().logExchange(sessionId, entries)
                        : await getSessions().sessionLog(sessionId, entries);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(written) }],
                    };
                }
                case 'tim_show_unsummarized': {
                    const { sessionId } = TimShowUnsummarizedSchema.parse(args);
                    const batch = await getSessions().showUnsummarized(sessionId);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(batch) }],
                    };
                }
                case 'tim_show_all_unsummarized': {
                    const batches = await getSessions().showAllUnsummarized();
                    return {
                        content: [{ type: 'text', text: formatToolResponse(batches) }],
                    };
                }
                case 'tim_show_untagged': {
                    const untagged = await getSessions().showUntagged();
                    return {
                        content: [{ type: 'text', text: formatToolResponse(untagged) }],
                    };
                }
                case 'tim_write_batch_summary': {
                    const { sessionId, batchIndex, summary, seqFrom, seqTo, tags } = TimWriteBatchSummarySchema.parse(args);
                    const node = await getSessions().writeBatchSummary(sessionId, batchIndex, summary, {
                        seqFrom,
                        seqTo,
                    }, tags);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(node) }],
                    };
                }
                case 'tim_rollup_session_summary': {
                    const { sessionId } = TimRollupSessionSummarySchema.parse(args);
                    const node = await getSessions().rollUpSession(sessionId, async (batches) => (0, tim_store_1.foldBatchSummaries)(batches));
                    return {
                        content: [{ type: 'text', text: formatToolResponse(node) }],
                    };
                }
                case 'tim_record_commit': {
                    const parsed = TimRecordCommitSchema.parse(args);
                    const entry = await getCommitManager().recordCommit(parsed);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(entry) }],
                    };
                }
                case 'tim_checkpoint': {
                    const { sessionId } = TimCheckpointSchema.parse(args);
                    const summary = await getSessions().checkpoint(sessionId);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(summary) }],
                    };
                }
                case 'tim_hook_prompt_submit': {
                    const { prompt, project } = TimHookPromptSubmitSchema.parse(args);
                    let projectLabel;
                    if (project) {
                        const resolved = await s.resolveProjectLabel(project);
                        if (resolved.status === 'found')
                            projectLabel = resolved.label;
                    }
                    else {
                        const roots = await resolveRoots(s, undefined);
                        if (roots.labels?.length === 1)
                            projectLabel = roots.labels[0];
                    }
                    const result = await (0, tim_hooks_1.runPromptSubmit)(s, { prompt, projectLabel });
                    if (!result) {
                        return {
                            content: [{ type: 'text', text: formatToolResponse({ context: null, lines: [] }) }],
                        };
                    }
                    return {
                        content: [{
                                type: 'text',
                                text: formatToolResponse({ context: result.context, lines: result.lines }),
                            }],
                    };
                }
                case 'tim_rename_entry': {
                    const { oldId, newId } = TimRenameEntrySchema.parse(args);
                    const entry = s.curate().renameEntry(oldId, newId);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(entry) }],
                    };
                }
                case 'tim_move_entry': {
                    const { id, newParentId, order } = TimMoveEntrySchema.parse(args);
                    const entry = s.curate().moveEntry(id, newParentId, order);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(entry) }],
                    };
                }
                case 'tim_update_many': {
                    const { ids, irrelevant, favorite } = TimUpdateManySchema.parse(args);
                    const entries = s.curate().updateMany(ids, { irrelevant, favorite });
                    return {
                        content: [{ type: 'text', text: formatToolResponse(entries) }],
                    };
                }
                case 'tim_tag_add': {
                    const { id, tags } = TimTagAddSchema.parse(args);
                    const tagWarnings = (0, tim_store_1.validateTagsDeprecated)(tags);
                    const { clean: cleanTags } = (0, tim_core_1.stripDeprecatedTags)(tags);
                    if (cleanTags.length === 0) {
                        const existing = await s.read(id);
                        if (!existing) {
                            return {
                                content: [{ type: 'text', text: `Entry not found: ${id}` }],
                                isError: true,
                            };
                        }
                        return {
                            content: [{
                                    type: 'text',
                                    text: formatToolResponse({ entry: existing, warnings: tagWarnings }),
                                }],
                        };
                    }
                    const entry = s.curate().tagAdd(id, cleanTags);
                    const payload = tagWarnings.length > 0 ? { entry, warnings: tagWarnings } : entry;
                    return {
                        content: [{ type: 'text', text: formatToolResponse(payload) }],
                    };
                }
                case 'tim_tag_remove': {
                    const { id, tags } = TimTagRemoveSchema.parse(args);
                    const entry = s.curate().tagRemove(id, tags);
                    return {
                        content: [{ type: 'text', text: formatToolResponse(entry) }],
                    };
                }
                case 'tim_tag_rename': {
                    const { oldTag, newTag } = TimTagRenameSchema.parse(args);
                    const count = s.curate().tagRename(oldTag, newTag);
                    return {
                        content: [{ type: 'text', text: formatToolResponse({ oldTag, newTag, updatedCount: count }) }],
                    };
                }
                case 'tim_create_project': {
                    const { label, metadata, content, aliases } = TimCreateProjectSchema.parse(args);
                    const entry = await s.createProject(label, { metadata, content, aliases });
                    return {
                        content: [{ type: 'text', text: formatToolResponse(entry) }],
                    };
                }
                case 'tim_load_project': {
                    const { label, depth, budget, sections, sessionId: sessionIdArg, bind } = TimLoadProjectSchema.parse(args);
                    const resolved = await s.resolveProjectLabel(label);
                    if (resolved.status === 'ambiguous') {
                        return errorResult(`Ambiguous alias: matches ${resolved.labels.join(', ')}. Use label.`);
                    }
                    if (resolved.status === 'not_found') {
                        return errorResult(`Project not found: ${label}`);
                    }
                    const projectLabel = resolved.label;
                    const cwd = isHttp ? undefined : process.cwd();
                    const sessionId = (0, tim_core_1.resolveActiveSessionId)({
                        sessionIdArg: sessionIdArg,
                        markerSession: cwd
                            ? (0, tim_hooks_1.findMarker)(cwd, { walkUp: true })?.marker.session
                            : undefined,
                        useSessionCache: !isHttp,
                        useEnv: !isHttp,
                    });
                    if (bind && sessionId) {
                        const existing = await s.read(sessionId);
                        if (existing?.metadata.kind === 'session') {
                            const existingRef = typeof existing.metadata.project_ref === 'string'
                                ? existing.metadata.project_ref
                                : undefined;
                            if ((0, tim_core_1.evaluateLoadGate)(existingRef, projectLabel) === 'reject') {
                                return errorResult(`Session already bound to ${existingRef}. tim_load_project binds once per session. ` +
                                    'Use tim_load_project with bind:false for cross-project access.');
                            }
                        }
                    }
                    const result = await s.loadProject(projectLabel, { depth, budget, sections });
                    if (!result) {
                        return errorResult(`Project not found: ${label}`);
                    }
                    if (bind && sessionId) {
                        try {
                            await getSessions().startProjectSession({
                                sessionId,
                                projectId: projectLabel,
                                agentName: 'mcp',
                                cwd: cwd ?? '',
                                harness: 'mcp',
                            });
                        }
                        catch {
                            // Non-critical — project brief still returned
                        }
                    }
                    if (cwd) {
                        try {
                            (0, tim_hooks_1.syncNearestProjectMarker)(cwd, projectLabel, { sessionId });
                        }
                        catch {
                            // Non-critical — brief still returned
                        }
                    }
                    const formatted = (0, project_output_js_1.formatProjectOutput)(result, budget, loadProjectSchema(), bind ? 'load' : 'read');
                    // Response-driven guidance: weak models follow response text more
                    // reliably than system prompts — spell out the standard next step.
                    const nextHint = bind
                        ? `\n\nNEXT: review the open tasks above (tim_show kind="tasks" for the full list). ` +
                            `Save new insights as you go: tim_write with where:"${projectLabel}/<Section>" ` +
                            `(Ideas, Decisions, Errors, Log) — never rely on chat history alone.`
                        : '';
                    return {
                        content: [{
                                type: 'text',
                                text: formatted + nextHint,
                            }],
                    };
                }
                case 'tim_read_project': {
                    const { label, depth, budget, sections } = TimReadProjectSchema.parse(args);
                    const resolved = await s.resolveProjectLabel(label);
                    if (resolved.status === 'ambiguous') {
                        return errorResult(`Ambiguous alias: matches ${resolved.labels.join(', ')}. Use label.`);
                    }
                    if (resolved.status === 'not_found') {
                        return errorResult(`Project not found: ${label}`);
                    }
                    const result = await s.loadProject(resolved.label, { depth, budget, sections });
                    if (!result) {
                        return errorResult(`Project not found: ${label}`);
                    }
                    const formatted = (0, project_output_js_1.formatProjectOutput)(result, budget, loadProjectSchema(), 'read');
                    return {
                        content: [{
                                type: 'text',
                                text: formatted,
                            }],
                    };
                }
                case 'tim_show': {
                    const { what, root, with: withStr, limit } = TimShowSchema.parse(args);
                    const roots = await resolveRoots(s, root);
                    if ('error' in roots && roots.error) {
                        return {
                            content: [{ type: 'text', text: roots.error }],
                            isError: true,
                        };
                    }
                    let entries = await fetchByWhat(s, what, roots.labels);
                    entries = await applyWith(s, entries, withStr);
                    entries = sortForShow(entries);
                    entries = entries.slice(0, limit);
                    const formatted = await formatShowOutput(s, entries);
                    return {
                        content: [{ type: 'text', text: formatted }],
                    };
                }
                case 'tim_error_stats': {
                    const { hours, limit } = TimErrorStatsSchema.parse(args);
                    const stats = getErrorLogger().getStats({ hours, limit });
                    const text = [
                        `=== ERROR STATS (last ${hours}h) ===`,
                        `Total errors: ${stats.totalErrors} | Error rate: ${stats.errorRate}/h`,
                        `--- Top Errors ---`,
                        ...stats.topErrors.map((e, i) => `  ${i + 1}. [${e.count}x] ${e.error} (last: ${e.lastSeen})`),
                        `--- By Tool ---`,
                        ...stats.byTool.map((t) => `  ${t.tool}: ${t.count}`),
                        stats.alerts.length > 0 ? `--- ALERTS ---` : '',
                        ...stats.alerts.map((a) => `  ${a}`),
                    ].filter((l) => l !== '').join('\n');
                    return { content: [{ type: 'text', text }] };
                }
                case 'tim_error_log': {
                    const { tool, error, stack, sessionId, args: toolArgs } = TimErrorLogSchema.parse(args);
                    getErrorLogger().logError({ tool, error, stack, sessionId, args: toolArgs });
                    return { content: [{ type: 'text', text: JSON.stringify({ logged: true }) }] };
                }
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                        isError: true,
                    };
            }
        }
        catch (error) {
            getErrorLogger().logError({
                tool: name,
                args,
                error: error.message ?? String(error),
                stack: error.stack,
            });
            return {
                content: [{ type: 'text', text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    return server;
}
async function createHttpServer(options) {
    const host = options?.host ?? CLI.host;
    const port = options?.port ?? CLI.port;
    const app = (0, express_js_1.createMcpExpressApp)({ host });
    const transports = new Map();
    const mcpServers = new Map();
    app.get('/sse', async (_req, res) => {
        try {
            const transport = new sse_js_1.SSEServerTransport('/messages', res);
            const mcpServer = await createMcpServer({ transportMode: 'http' });
            transports.set(transport.sessionId, transport);
            mcpServers.set(transport.sessionId, mcpServer);
            res.on('close', () => {
                transports.delete(transport.sessionId);
                mcpServers.delete(transport.sessionId);
                void mcpServer.close().catch(() => { });
            });
            await mcpServer.connect(transport);
        }
        catch (err) {
            console.error('[tim-mcp] SSE connection error:', err);
            if (!res.headersSent) {
                res.status(500).end('Internal Server Error');
            }
        }
    });
    app.post('/messages', async (req, res) => {
        const sessionId = req.query.sessionId;
        if (!sessionId) {
            res.status(400).end('Missing sessionId');
            return;
        }
        const transport = transports.get(sessionId);
        if (!transport) {
            res.status(404).end('Not found');
            return;
        }
        await transport.handlePostMessage(req, res, req.body);
    });
    installProcessErrorGuards();
    const httpServer = await new Promise((resolve, reject) => {
        const listener = app.listen(port, host);
        listener.once('listening', () => resolve(listener));
        listener.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`[tim-mcp] FATAL: Port ${port} already in use on ${host}`);
            }
            reject(err);
        });
    });
    const addr = httpServer.address();
    const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
    const close = async () => {
        for (const transport of transports.values()) {
            try {
                await transport.close();
            }
            catch {
                // Best-effort cleanup.
            }
        }
        transports.clear();
        await Promise.all(Array.from(mcpServers.values()).map(s => s.close().catch(() => { })));
        mcpServers.clear();
        await new Promise((resolve, reject) => {
            httpServer.close(err => (err ? reject(err) : resolve()));
        });
    };
    return { app, httpServer, port: actualPort, close, activeConnections: () => mcpServers.size };
}
async function startServer() {
    installProcessErrorGuards();
    if (CLI.http) {
        let handle;
        try {
            handle = await createHttpServer();
        }
        catch (err) {
            if (err?.code === 'EADDRINUSE') {
                process.exit(1);
            }
            throw err;
        }
        console.error(`TIM MCP server started (HTTP/SSE http://${CLI.host}:${handle.port}, DB: ${DB_PATH})`);
        const shutdown = async () => {
            await handle.close();
            process.exit(0);
        };
        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });
        return;
    }
    const server = await createMcpServer();
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error(`TIM MCP server started (DB: ${DB_PATH})`);
}
// Run if executed directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
    startServer().catch(console.error);
}
//# sourceMappingURL=server.js.map