// TIM MCP Server — v0.1.0-alpha
// MCP stdio server with curation, session, and core memory tools.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TimStore, SessionManager } from 'tim-store';
import { loadConfig, type EdgeType } from 'tim-core';
import { tim_export, tim_import } from 'tim-migrate';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Tool Schemas ───────────────────────────────────────

const TimReadSchema = z.object({
  id: z.string().describe('Entry ID (ULID)'),
  depth: z.number().min(1).max(5).optional().default(2),
  includeEdges: z.boolean().optional().default(false),
  showIrrelevant: z.boolean().optional().default(false),
});

const TimWriteSchema = z.object({
  content: z.string().describe('Entry content'),
  parentId: z.string().optional(),
  contentType: z.enum(['text', 'json', 'blob']).optional().default('text'),
  confidence: z.number().min(0).max(1).optional().default(1.0),
  tags: z.array(z.string()).optional().default([]),
  visibility: z.number().optional().default(1),
  metadata: z.record(z.unknown()).optional().default({}),
});

const TimSearchSchema = z.object({
  query: z.string().describe('FTS5 search query'),
  topK: z.number().min(1).max(100).optional().default(10),
  searchType: z.enum(['fts', 'vector', 'hybrid']).optional().default('fts'),
});

const TimLinkSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  type: z.enum([
    'relates', 'extends', 'contradicts', 'implements',
    'blocks', 'leases', 'tagged', 'summarizes', 'contradicted_by'
  ]),
  weight: z.number().min(0).max(1).optional().default(1.0),
  metadata: z.record(z.unknown()).optional().default({}),
});

const TimTraceSchema = z.object({
  startId: z.string(),
  edgeType: z.string().optional(),
  depth: z.number().min(1).max(20).optional().default(5),
});

const TimUpdateSchema = z.object({
  id: z.string(),
  content: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const TimDeleteSchema = z.object({
  id: z.string(),
  hard: z.boolean().optional().default(false),
});

const TimSyncSchema = z.object({
  action: z.enum(['push', 'pull', 'status']),
  stagingRecords: z.array(z.object({
    key: z.string(),
    entityType: z.enum(['entry', 'edge']),
    operation: z.enum(['upsert', 'delete']),
    payload: z.string(),
    lwwTimestamp: z.number(),
    lwwDevice: z.string(),
    lwwConfidence: z.number().optional().default(1.0),
    acked: z.boolean().optional().default(false),
  })).optional(),
});

const TimLeaseSchema = z.object({
  grant: z.string().optional().describe('Agent label to grant access to'),
  revoke: z.string().optional().describe('Agent label to revoke access from'),
  entryId: z.string(),
  ttl: z.string().optional().describe('Duration: 1h, 30m, 7d'),
});

const TimSuppressSchema = z.object({
  pattern: z.string(),
  reason: z.string().optional().default('Manual suppression'),
  ttl: z.string().optional(),
});

const TimExportSchema = z.object({
  format: z.enum(['text', 'hmem', 'md']).optional().default('text'),
  targetPath: z.string().optional().describe('Output path for hmem export'),
});

const TimImportSchema = z.object({
  source: z.string().describe('Path to .hmem file'),
  dryRun: z.boolean().optional().default(false),
  deduplicate: z.boolean().optional().default(false),
});

const TimDoctorSchema = z.object({});

const TimSessionStartSchema = z.object({
  sessionId: z.string(),
  agentName: z.string().optional().default('default'),
  cwd: z.string().optional(),
  harness: z.string().optional().default('mcp'),
});

const TimSessionLogSchema = z.object({
  sessionId: z.string(),
  entries: z.array(z.object({
    role: z.enum(['user', 'agent']),
    content: z.string(),
  })),
});

const TimCheckpointSchema = z.object({
  sessionId: z.string(),
});

const TimRenameEntrySchema = z.object({
  oldId: z.string(),
  newId: z.string(),
});

const TimMoveEntrySchema = z.object({
  id: z.string(),
  newParentId: z.string().nullable().optional().default(null),
});

const TimUpdateManySchema = z.object({
  ids: z.array(z.string()).min(1),
  irrelevant: z.boolean().optional(),
  favorite: z.boolean().optional(),
});

const TimTagAddSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()).min(1),
});

const TimTagRemoveSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()).min(1),
});

const TimTagRenameSchema = z.object({
  oldTag: z.string(),
  newTag: z.string(),
});

// ─── MCP Server Setup ───────────────────────────────────

const DB_PATH = process.env.TIM_DB_PATH || loadConfig().dbPath || process.env.HOME + '/.tim/tim.db';

let store: TimStore;
let sessions: SessionManager;

function getStore(): TimStore {
  if (!store) {
    store = new TimStore(DB_PATH);
  }
  return store;
}

function getSessions(): SessionManager {
  if (!sessions) {
    sessions = new SessionManager(getStore());
  }
  return sessions;
}

export async function startServer(): Promise<void> {
  const server = new Server(
    {
      name: 'tim-mcp',
      version: '0.1.0-alpha',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ─── Tool Registration ──────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
        description: 'Export TIM database to markdown or .hmem SQLite format.',
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['text', 'hmem', 'md'], default: 'text' },
            targetPath: { type: 'string', description: 'Output path (required for hmem format)' },
          },
        },
      },
      {
        name: 'tim_import',
        description: 'Import entries from a .hmem SQLite file.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            dryRun: { type: 'boolean', default: false },
            deduplicate: { type: 'boolean', default: false },
          },
          required: ['source'],
        },
      },
      {
        name: 'tim_doctor',
        description: 'Run comprehensive diagnostics: config, DB, API connectivity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tim_session_start',
        description: 'Start a TIM session (idempotent). Creates a session root entry.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            agentName: { type: 'string', default: 'default' },
            cwd: { type: 'string' },
            harness: { type: 'string', default: 'mcp' },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'tim_session_log',
        description: 'Append exchange entries to a session log.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'agent'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
              },
            },
          },
          required: ['sessionId', 'entries'],
        },
      },
      {
        name: 'tim_checkpoint',
        description: 'Create a session checkpoint summary and run verify-before-decay.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'tim_rename_entry',
        description: 'Atomically rename an entry ID and update all references (edges, parent_id, staging, metadata).',
        inputSchema: {
          type: 'object',
          properties: {
            oldId: { type: 'string', description: 'Current entry ID' },
            newId: { type: 'string', description: 'New entry ID (must not exist)' },
          },
          required: ['oldId', 'newId'],
        },
      },
      {
        name: 'tim_move_entry',
        description: 'Move an entry under a new parent and cascade depth updates to descendants.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Entry ID to move' },
            newParentId: { type: ['string', 'null'], description: 'New parent ID, or null for root' },
          },
          required: ['id'],
        },
      },
      {
        name: 'tim_update_many',
        description: 'Batch-update irrelevant and/or favorite flags on multiple entries (flags only, never content).',
        inputSchema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
            irrelevant: { type: 'boolean' },
            favorite: { type: 'boolean' },
          },
          required: ['ids'],
        },
      },
      {
        name: 'tim_tag_add',
        description: 'Add tags to an entry (deduplicated).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          required: ['id', 'tags'],
        },
      },
      {
        name: 'tim_tag_remove',
        description: 'Remove tags from an entry.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          required: ['id', 'tags'],
        },
      },
      {
        name: 'tim_tag_rename',
        description: 'Rename a tag across all entries (exact match only, safe for substring collisions).',
        inputSchema: {
          type: 'object',
          properties: {
            oldTag: { type: 'string' },
            newTag: { type: 'string' },
          },
          required: ['oldTag', 'newTag'],
        },
      },
    ],
  }));

  // ─── Tool Handler ────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const s = getStore();
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'tim_read': {
          const { id, depth, includeEdges, showIrrelevant } = TimReadSchema.parse(args);
          const entry = await s.read(id, { depth, includeEdges, showIrrelevant });
          if (!entry) return { content: [{ type: 'text', text: 'Entry not found' }] };
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
          const edge = await s.link(sourceId, targetId, type as EdgeType, weight, metadata);
          return {
            content: [{ type: 'text', text: JSON.stringify(edge, null, 2) }],
          };
        }

        case 'tim_trace': {
          const { startId, edgeType, depth } = TimTraceSchema.parse(args);
          const chain = await s.traceChain(startId, edgeType as EdgeType | undefined, depth);
          return {
            content: [{ type: 'text', text: JSON.stringify(chain, null, 2) }],
          };
        }

        case 'tim_update': {
          const { id, ...patch } = TimUpdateSchema.parse(args);
          const entry = await s.update(id, patch as any);
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
            if (!agent) return { content: [{ type: 'text', text: `Agent "${grant}" not registered` }] };
            await s.link(entryId, agent.id, 'leases', 1.0, ttl ? { ttl } : {});
            return { content: [{ type: 'text', text: `Leased entry ${entryId} to ${grant}` + (ttl ? ` (TTL: ${ttl})` : '') }] };
          }
          if (revoke) {
            const edges = await s.getEdges(entryId, 'outgoing');
            const leaseEdge = edges.find(e => e.type === 'leases');
            if (leaseEdge) {
              await s.update(leaseEdge.id, { irrelevant: true } as any);
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
          const { format, targetPath } = TimExportSchema.parse(args);
          const exportFormat = format === 'md' ? 'text' : format;
          if (exportFormat === 'text') {
            const md = tim_export(s, undefined, { format: 'text' });
            return { content: [{ type: 'text', text: md }] };
          }
          const outPath = targetPath ?? path.join(os.tmpdir(), `tim-export-${Date.now()}.hmem`);
          const result = tim_export(s, outPath, { format: 'hmem' });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'tim_import': {
          const { source, dryRun, deduplicate } = TimImportSchema.parse(args);
          if (!fs.existsSync(source)) {
            return { content: [{ type: 'text', text: `Source not found: ${source}` }] };
          }
          const report = tim_import(s, source, { dryRun, deduplicate });
          return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
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

        case 'tim_session_start': {
          const { sessionId, agentName, cwd, harness } = TimSessionStartSchema.parse(args);
          const entry = await getSessions().sessionStart({
            sessionId,
            agentName,
            cwd: cwd ?? process.cwd(),
            harness,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_session_log': {
          const { sessionId, entries } = TimSessionLogSchema.parse(args);
          const written = await getSessions().sessionLog(sessionId, entries);
          return {
            content: [{ type: 'text', text: JSON.stringify(written, null, 2) }],
          };
        }

        case 'tim_checkpoint': {
          const { sessionId } = TimCheckpointSchema.parse(args);
          const summary = await getSessions().checkpoint(sessionId);
          return {
            content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
          };
        }

        case 'tim_rename_entry': {
          const { oldId, newId } = TimRenameEntrySchema.parse(args);
          const entry = s.curate().renameEntry(oldId, newId);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_move_entry': {
          const { id, newParentId } = TimMoveEntrySchema.parse(args);
          const entry = s.curate().moveEntry(id, newParentId);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_update_many': {
          const { ids, irrelevant, favorite } = TimUpdateManySchema.parse(args);
          const entries = s.curate().updateMany(ids, { irrelevant, favorite });
          return {
            content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
          };
        }

        case 'tim_tag_add': {
          const { id, tags } = TimTagAddSchema.parse(args);
          const entry = s.curate().tagAdd(id, tags);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_tag_remove': {
          const { id, tags } = TimTagRemoveSchema.parse(args);
          const entry = s.curate().tagRemove(id, tags);
          return {
            content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }],
          };
        }

        case 'tim_tag_rename': {
          const { oldTag, newTag } = TimTagRenameSchema.parse(args);
          const count = s.curate().tagRename(oldTag, newTag);
          return {
            content: [{ type: 'text', text: JSON.stringify({ oldTag, newTag, updatedCount: count }, null, 2) }],
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error: any) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  // ─── Start ────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TIM MCP server started (DB: ${DB_PATH})`);
}

// Run if executed directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  startServer().catch(console.error);
}
