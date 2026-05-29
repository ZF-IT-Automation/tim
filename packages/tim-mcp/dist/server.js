"use strict";
// TIM MCP Server — v0.1.0-alpha
// MCP stdio server with 15 tools for AI agents.
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const zod_1 = require("zod");
const tim_store_1 = require("tim-store");
// ─── Tool Schemas ───────────────────────────────────────
const TimReadSchema = zod_1.z.object({
    id: zod_1.z.string().describe('Entry ID (ULID)'),
    depth: zod_1.z.number().min(1).max(5).optional().default(2),
    includeEdges: zod_1.z.boolean().optional().default(false),
    showIrrelevant: zod_1.z.boolean().optional().default(false),
});
const TimWriteSchema = zod_1.z.object({
    content: zod_1.z.string().describe('Entry content'),
    parentId: zod_1.z.string().optional(),
    contentType: zod_1.z.enum(['text', 'json', 'blob']).optional().default('text'),
    confidence: zod_1.z.number().min(0).max(1).optional().default(1.0),
    tags: zod_1.z.array(zod_1.z.string()).optional().default([]),
    visibility: zod_1.z.number().optional().default(1),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional().default({}),
});
const TimSearchSchema = zod_1.z.object({
    query: zod_1.z.string().describe('FTS5 search query'),
    topK: zod_1.z.number().min(1).max(100).optional().default(10),
    searchType: zod_1.z.enum(['fts', 'vector', 'hybrid']).optional().default('fts'),
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
    content: zod_1.z.string().optional(),
    confidence: zod_1.z.number().min(0).max(1).optional(),
    tags: zod_1.z.array(zod_1.z.string()).optional(),
    visibility: zod_1.z.number().optional(),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
});
const TimDeleteSchema = zod_1.z.object({
    id: zod_1.z.string(),
    hard: zod_1.z.boolean().optional().default(false),
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
    format: zod_1.z.enum(['md', 'tim', 'json']).optional().default('md'),
});
const TimImportSchema = zod_1.z.object({
    source: zod_1.z.string().describe('Path to .tim or .hmem file'),
});
const TimDoctorSchema = zod_1.z.object({});
// ─── MCP Server Setup ───────────────────────────────────
const DB_PATH = process.env.TIM_DB_PATH || process.env.HOME + '/.tim/tim.db';
let store;
function getStore() {
    if (!store) {
        store = new tim_store_1.TimStore(DB_PATH);
    }
    return store;
}
async function startServer() {
    const server = new index_js_1.Server({
        name: 'tim-mcp',
        version: '0.1.0-alpha',
    }, {
        capabilities: {
            tools: {},
        },
    });
    // ─── Tool Registration ──────────────────────────────
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'tim_read',
                description: 'Read an entry from TIM. Returns entry content, children, and optional edges.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Entry ID (ULID)' },
                        depth: { type: 'number', default: 2, description: 'How many levels to read (1-5)' },
                        includeEdges: { type: 'boolean', default: false },
                        showIrrelevant: { type: 'boolean', default: false },
                    },
                    required: ['id'],
                },
            },
            {
                name: 'tim_write',
                description: 'Write a new entry to TIM with optional tags, confidence, and visibility.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        content: { type: 'string' },
                        parentId: { type: 'string' },
                        contentType: { type: 'string', enum: ['text', 'json', 'blob'], default: 'text' },
                        confidence: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
                        tags: { type: 'array', items: { type: 'string' }, default: [] },
                        visibility: { type: 'number', default: 1 },
                        metadata: { type: 'object', default: {} },
                    },
                    required: ['content'],
                },
            },
            {
                name: 'tim_search',
                description: 'Search TIM entries using FTS5 full-text search.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        topK: { type: 'number', default: 10 },
                        searchType: { type: 'string', enum: ['fts', 'vector', 'hybrid'], default: 'fts' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'tim_link',
                description: 'Create an edge (relationship) between two entries.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceId: { type: 'string' },
                        targetId: { type: 'string' },
                        type: { type: 'string', enum: ['relates', 'extends', 'contradicts', 'implements', 'blocks', 'leases', 'tagged', 'summarizes', 'contradicted_by'] },
                        weight: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
                        metadata: { type: 'object', default: {} },
                    },
                    required: ['sourceId', 'targetId', 'type'],
                },
            },
            {
                name: 'tim_trace',
                description: 'Follow an edge chain from a starting entry (BFS traversal).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        startId: { type: 'string' },
                        edgeType: { type: 'string' },
                        depth: { type: 'number', default: 5 },
                    },
                    required: ['startId'],
                },
            },
            {
                name: 'tim_update',
                description: 'Update an existing entry. Only provided fields are changed.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        content: { type: 'string' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                        tags: { type: 'array', items: { type: 'string' } },
                        visibility: { type: 'number' },
                        metadata: { type: 'object' },
                    },
                    required: ['id'],
                },
            },
            {
                name: 'tim_delete',
                description: 'Delete an entry (soft: mark irrelevant, hard: tombstone).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        hard: { type: 'boolean', default: false },
                    },
                    required: ['id'],
                },
            },
            {
                name: 'tim_sync',
                description: 'Sync operations: push staging records, pull from remote, or check status.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['push', 'pull', 'status'] },
                        stagingRecords: { type: 'array' },
                    },
                    required: ['action'],
                },
            },
            {
                name: 'tim_lease',
                description: 'Grant or revoke temporary agent access to a memory entry.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        grant: { type: 'string' },
                        revoke: { type: 'string' },
                        entryId: { type: 'string' },
                        ttl: { type: 'string' },
                    },
                    required: ['entryId'],
                },
            },
            {
                name: 'tim_suppress',
                description: 'Add a pattern to negative memory. Matching entries are hidden from search results.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string' },
                        reason: { type: 'string', default: 'Manual suppression' },
                        ttl: { type: 'string' },
                    },
                    required: ['pattern'],
                },
            },
            {
                name: 'tim_health',
                description: 'Run health diagnostics: broken links, orphans, FTS integrity, counts.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'tim_stats',
                description: 'Get memory statistics: totals, depth distribution, top tags, confidence.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'tim_export',
                description: 'Export TIM database to markdown, .tim, or JSON format.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        format: { type: 'string', enum: ['md', 'tim', 'json'], default: 'md' },
                    },
                },
            },
            {
                name: 'tim_import',
                description: 'Import entries from a .tim or .hmem file.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        source: { type: 'string' },
                    },
                    required: ['source'],
                },
            },
            {
                name: 'tim_doctor',
                description: 'Run comprehensive diagnostics: config, DB, API connectivity.',
                inputSchema: { type: 'object', properties: {} },
            },
        ],
    }));
    // ─── Tool Handler ────────────────────────────────────
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const s = getStore();
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case 'tim_read': {
                    const { id, depth, includeEdges, showIrrelevant } = TimReadSchema.parse(args);
                    const entry = await s.read(id, { depth, includeEdges, showIrrelevant });
                    if (!entry)
                        return { content: [{ type: 'text', text: 'Entry not found' }] };
                    const edges = includeEdges ? await s.getEdges(id, 'both') : [];
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ entry, edges }, null, 2) }],
                    };
                }
                case 'tim_write': {
                    const opts = TimWriteSchema.parse(args);
                    const entry = await s.write(opts.content, opts);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
                    };
                }
                case 'tim_search': {
                    const { query, topK } = TimSearchSchema.parse(args);
                    const results = await s.search({ query, topK });
                    return {
                        content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
                    };
                }
                case 'tim_link': {
                    const { sourceId, targetId, type, weight, metadata } = TimLinkSchema.parse(args);
                    const edge = await s.link(sourceId, targetId, type, weight, metadata);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(edge, null, 2) }],
                    };
                }
                case 'tim_trace': {
                    const { startId, edgeType, depth } = TimTraceSchema.parse(args);
                    const chain = await s.traceChain(startId, edgeType, depth);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(chain, null, 2) }],
                    };
                }
                case 'tim_update': {
                    const { id, ...patch } = TimUpdateSchema.parse(args);
                    const entry = await s.update(id, patch);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
                    };
                }
                case 'tim_delete': {
                    const { id, hard } = TimDeleteSchema.parse(args);
                    await s.delete(id, hard);
                    return {
                        content: [{ type: 'text', text: `Entry ${id} ${hard ? 'hard-deleted' : 'marked irrelevant'}` }],
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
                        default:
                            return { content: [{ type: 'text', text: `Sync action '${action}' not yet implemented` }] };
                    }
                }
                case 'tim_lease': {
                    const { grant, revoke, entryId, ttl } = TimLeaseSchema.parse(args);
                    if (grant) {
                        const agents = await s.getAgents();
                        const agent = agents.find(a => a.label === grant);
                        if (!agent)
                            return { content: [{ type: 'text', text: `Agent "${grant}" not registered` }] };
                        await s.link(entryId, agent.id, 'leases', 1.0, ttl ? { ttl } : {});
                        return { content: [{ type: 'text', text: `Leased entry ${entryId} to ${grant}` + (ttl ? ` (TTL: ${ttl})` : '') }] };
                    }
                    if (revoke) {
                        const edges = await s.getEdges(entryId, 'outgoing');
                        const leaseEdge = edges.find(e => e.type === 'leases');
                        if (leaseEdge) {
                            await s.update(leaseEdge.id, { irrelevant: true });
                            return { content: [{ type: 'text', text: `Revoked lease on ${entryId}` }] };
                        }
                        return { content: [{ type: 'text', text: `No active lease found for ${entryId}` }] };
                    }
                    return { content: [{ type: 'text', text: 'Specify grant= or revoke=' }] };
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
                        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
                    };
                }
                case 'tim_stats': {
                    const stats = await s.stats();
                    return {
                        content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
                    };
                }
                case 'tim_export': {
                    const { format } = TimExportSchema.parse(args);
                    if (format === 'md') {
                        // Dump all entries as markdown
                        const stats = await s.stats();
                        let md = `# TIM Export — ${new Date().toISOString()}\n\n`;
                        md += `Entries: ${stats.totalEntries}, Edges: ${stats.totalEdges}\n\n`;
                        // For now, return summary. Full export needs cursor-based pagination.
                        md += `## Top Tags\n`;
                        for (const t of stats.topTags.slice(0, 10)) {
                            md += `- ${t.tag}: ${t.count}\n`;
                        }
                        return { content: [{ type: 'text', text: md }] };
                    }
                    return { content: [{ type: 'text', text: `Export format '${format}' not yet implemented` }] };
                }
                case 'tim_import': {
                    const { source } = TimImportSchema.parse(args);
                    return { content: [{ type: 'text', text: `Import from ${source} not yet implemented` }] };
                }
                case 'tim_doctor': {
                    const report = await s.health();
                    const stats = await s.stats();
                    const agents = await s.getAgents();
                    const text = [
                        `TIM Doctor — ${DB_PATH}`,
                        `Entries: ${stats.totalEntries} | Edges: ${stats.totalEdges}`,
                        `Broken links: ${report.brokenLinks} | Orphans: ${report.orphanEntries}`,
                        `FTS5: ${report.ftsIntegrity ? 'OK' : 'BROKEN'}`,
                        `Agents registered: ${agents.length}`,
                        `DB path: ${DB_PATH}`,
                        ...report.issues.map(i => `⚠ ${i}`),
                    ].join('\n');
                    return { content: [{ type: 'text', text }] };
                }
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
                        isError: true,
                    };
            }
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Error: ${error.message}` }],
                isError: true,
            };
        }
    });
    // ─── Start ────────────────────────────────────────────
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error(`TIM MCP server started (DB: ${DB_PATH})`);
}
// Run if executed directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
    startServer().catch(console.error);
}
//# sourceMappingURL=server.js.map