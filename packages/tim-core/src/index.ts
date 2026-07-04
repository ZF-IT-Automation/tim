// TIM Core Types — v0.1.0-alpha
// These types define the contract that all modules must implement.

import { ulid } from 'ulid';

// ─── Entry ────────────────────────────────────────────────

export type ContentType = 'text' | 'json' | 'blob';

export {
  BUILTIN_METADATA_TYPES,
  BUILTIN_TYPES,
  LEGACY_METADATA_TYPES,
  ALL_METADATA_TYPES,
  METADATA_TYPES,
  type BuiltinMetadataType,
  type BuiltinType,
  type LegacyMetadataType,
  type MetadataType,
  type EntryMetadata,
  type TaskMetadata,
  type RuleMetadata,
  type BugMetadata,
  isBuiltinMetadataType,
  isBuiltinType,
  isMetadataType,
  normalizeLegacyTypeTag,
  DEPRECATED_STATUS_TAGS,
  DEPRECATED_PRIORITY_TAGS,
  DEPRECATED_TAGS,
  isDeprecatedTag,
  stripDeprecatedTags,
} from './types.js';

export interface Entry {
  id: string;                    // ULID
  parentId: string | null;       // null = root
  title: string;
  content: string;
  contentType: ContentType;
  depth: number;                 // 1-5
  confidence: number;            // 0.0-1.0
  createdAt: string;             // ISO 8601
  accessedAt: string;
  updatedAt: string;             // ISO 8601 — last content/metadata change
  decayRate: number;             // 0.0 = never decay
  visibility: number;            // bitmask: 1=owner, 2=trusted, 4=leased, 8=public
  tags: string[];                // e.g. ['#sql', '#bug']
  irrelevant: boolean;           // soft delete
  favorite: boolean;             // curated highlight flag
  tombstonedAt: string | null;   // hard-delete marker
  metadata: import('./types.js').EntryMetadata;
}

// ─── Edge ─────────────────────────────────────────────────

export type EdgeType = 'relates' | 'extends' | 'contradicts' | 'implements' |
                       'blocks' | 'leases' | 'tagged' | 'summarizes' |
                       'session_exchange' | 'contradicted_by';

export interface Edge {
  id: string;                    // ULID
  sourceId: string;
  targetId: string;
  type: EdgeType;
  weight: number;                // 0.0-1.0
  metadata: Record<string, unknown>; // lease_expiry, confidence_override, ...
}

// ─── Agent ────────────────────────────────────────────────

export interface AgentIdentity {
  id: string;                    // ULID
  name: string;                  // e.g. "Claude Code"
  label: string;                 // e.g. "claude"
  registeredAt: string;
  visibilityMask: number;        // default: 1 (owner)
}

// ─── Read/Write Options ───────────────────────────────────

export interface ReadOptions {
  depth?: number;                // 1-5, default: 2
  includeEdges?: boolean;
  includeChildren?: boolean;
  confidenceAbove?: number;      // filter: only high-confidence entries
  visibilityMask?: number;       // which agents can see this
  showIrrelevant?: boolean;
}

export interface WriteOptions {
  id?: string;                   // optional fixed ULID (e.g. session id)
  title?: string;
  parentId?: string | null;
  contentType?: ContentType;
  confidence?: number;
  decayRate?: number;
  visibility?: number;
  tags?: string[];
  edges?: Omit<Edge, 'id'>[];   // edges to create alongside entry
  metadata?: Record<string, unknown>;
}

export interface DecayOptions {
  before: string;                // ISO 8601 — decay entries older than this
  exclude?: string[];            // entry IDs to skip
}

export interface SearchOptions {
  query: string;
  topK?: number;
  searchType?: 'fts' | 'vector' | 'hybrid';
  confidenceAbove?: number;
  visibilityMask?: number;
}

// ─── Staging (for sync) ───────────────────────────────────

export type SyncOperation = 'upsert' | 'delete';
export type SyncEntity = 'entry' | 'edge';

export interface StagingRecord {
  key: string;                   // entry_id or edge_id
  entityType: SyncEntity;
  operation: SyncOperation;
  payload: string;               // full row as JSON
  lwwTimestamp: number;          // Unix ms
  lwwDevice: string;             // device ULID
  lwwConfidence: number;
  acked: boolean;
}

export { resolveLWW } from './lww.js';
export type { ConflictResolution } from './lww.js';

// ─── Memory Interface (implemented by tim-store) ──────────

export interface MemoryInterface {
  // CRUD
  read(id: string, options?: ReadOptions): Promise<Entry | null>;
  write(content: string, options?: WriteOptions): Promise<Entry>;
  update(id: string, patch: Partial<Entry>): Promise<Entry>;
  delete(id: string, hard?: boolean): Promise<void>;

  // Search
  search(options: SearchOptions): Promise<Entry[]>;
  searchFts(query: string, limit?: number): Promise<Entry[]>;

  // Edges
  link(sourceId: string, targetId: string, type: EdgeType,
       weight?: number, metadata?: Record<string, unknown>): Promise<Edge>;
  getEdges(id: string, direction?: 'outgoing' | 'incoming' | 'both'): Promise<Edge[]>;
  traceChain(startId: string, edgeType?: EdgeType, depth?: number): Promise<Entry[]>;

  // Agents
  registerAgent(name: string, label: string): Promise<AgentIdentity>;
  getAgents(): Promise<AgentIdentity[]>;

  // Sync
  getStaging(cursor?: number): Promise<StagingRecord[]>;
  applyStaging(records: StagingRecord[]): Promise<void>;
  getStagingCursor(): Promise<number>;
  gcStaging(olderThanDays: number): Promise<number>;

  // Health
  health(): Promise<HealthReport>;
  stats(): Promise<MemoryStats>;
  getContentStats(root?: string, kind?: string, buckets?: number[]): Promise<ContentStats>;
  deleteBatch(ids: string[], hard?: boolean): Promise<number>;

  // Suppression
  suppress(pattern: string, reason: string, ttl?: string): Promise<void>;
  isSuppressed(content: string): Promise<boolean>;

  // REM decay
  runDecay(options: DecayOptions): Promise<number>;
}

// ─── Health / Stats ───────────────────────────────────────

export interface HealthReport {
  brokenLinks: number;
  orphanEntries: number;
  ftsIntegrity: boolean;
  totalEntries: number;
  totalEdges: number;
  issues: string[];
}

export interface MemoryStats {
  totalEntries: number;
  totalEdges: number;
  entriesByDepth: Record<number, number>;
  entriesByType: Record<string, number>;
  topTags: { tag: string; count: number }[];
  avgConfidence: number;
  oldestEntry: string | null;    // ISO 8601
  newestEntry: string | null;
  staleCount: number;            // not accessed in 30d
}

export interface ContentStats {
  totalEntries: number;
  totalContentBytes: number;
  avgContentChars: number;
  maxContentChars: number;
  minContentChars: number;
  buckets: { threshold: string; count: number }[];
  byKind: { kind: string; count: number; totalBytes: number }[];
}

// ─── Event Bus ────────────────────────────────────────────

export type EventType =
  | 'memory:written'
  | 'memory:updated'
  | 'memory:deleted'
  | 'edge:created'
  | 'edge:deleted'
  | 'sync:pushed'
  | 'sync:pulled'
  | 'agent:registered'
  | 'rem:decay'
  | 'rem:compress'
  | 'rem:health';

export interface MemoryEvent {
  type: EventType;
  timestamp: string;
  payload: unknown;
}

export type EventHandler = (event: MemoryEvent) => void | Promise<void>;

export interface EventBus {
  on(type: EventType, handler: EventHandler): void;
  off(type: EventType, handler: EventHandler): void;
  emit(type: EventType, payload: unknown): Promise<void>;
}

// ─── Plugin System ────────────────────────────────────────

export interface Plugin {
  name: string;
  version: string;
  hooks: Partial<Record<EventType, EventHandler>>;
}

export interface PluginRegistry {
  register(plugin: Plugin): void;
  unregister(name: string): void;
  get(name: string): Plugin | undefined;
  list(): Plugin[];
}

// ─── Kernel ────────────────────────────────────────────────

export interface TimKernel {
  memory: MemoryInterface;
  events: EventBus;
  plugins: PluginRegistry;
  agents: AgentIdentity[];
  config: TimConfig;
}

export interface TimHooksConfig {
  sessionStart?: string | string[];
  sessionEnd?: string | string[];
  enabled?: boolean;
  timeoutMs?: number;
}

export interface TimConfig {
  dbPath: string;
  deviceId: string;
  syncServer?: string;
  remSleepInterval?: number;
  defaultVisibility?: number;
  defaultConfidence?: number;
  hooks?: TimHooksConfig;
  sync?: {
    server: string;
    token?: string;
  };
  summarizer?: {
    timeout_sec?: number;
    chain: Array<{
      cli: string;
      model: string;
      provider?: string;
      label?: string;
    }>;
  };
  projectSummary?: {
    sessions_threshold?: number;
  };
  batch_size?: number;
  remember?: {
    enabled?: boolean;
    chain?: Array<{ cli: string; model: string; provider?: string }>;
    timeout_sec?: number;
    hard_timeout_ms?: number;
    maxCandidates?: number;
    topK?: number;
    minConfidence?: number;
    includeBatchSummaries?: boolean;
    searchType?: 'fts';
  };
}

export {
  type ProjectMetadata,
  type ResolveProjectResult,
  type SectionCandidate,
  type ResolveSectionResult,
} from './project.js';
export { InProcessEventBus } from './event-bus.js';
export {
  loadConfig,
  saveConfig,
  getConfigPath,
  getTimDir,
  normalizeHookScripts,
  hooksEnabled,
  type HooksConfig,
  type RememberConfig,
  type TimConfigFile,
} from './config.js';
export {
  readTimSessionCache,
  resolveActiveSessionId,
  timSessionCachePath,
  type TimSessionCache,
} from './session-cache.js';
export { evaluateLoadGate } from './load-gate.js';
export { SCHEMA_KINDS } from './schema-kinds.js';
