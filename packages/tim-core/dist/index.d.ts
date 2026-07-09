import type { HealthReport } from './types.js';
export type ContentType = 'text' | 'json' | 'blob';
export { BUILTIN_METADATA_TYPES, BUILTIN_TYPES, LEGACY_METADATA_TYPES, ALL_METADATA_TYPES, METADATA_TYPES, type BuiltinMetadataType, type BuiltinType, type LegacyMetadataType, type MetadataType, type EntryMetadata, type TaskMetadata, type RuleMetadata, type BugMetadata, type HealthSeverity, type HealthReport, isBuiltinMetadataType, isBuiltinType, isMetadataType, normalizeLegacyTypeTag, DEPRECATED_STATUS_TAGS, DEPRECATED_PRIORITY_TAGS, DEPRECATED_TAGS, isDeprecatedTag, stripDeprecatedTags, } from './types.js';
export interface Entry {
    id: string;
    parentId: string | null;
    title: string;
    content: string;
    contentType: ContentType;
    depth: number;
    confidence: number;
    createdAt: string;
    accessedAt: string;
    updatedAt: string;
    decayRate: number;
    visibility: number;
    tags: string[];
    irrelevant: boolean;
    favorite: boolean;
    tombstonedAt: string | null;
    metadata: import('./types.js').EntryMetadata;
}
export type EdgeType = 'relates' | 'extends' | 'contradicts' | 'implements' | 'blocks' | 'leases' | 'tagged' | 'summarizes' | 'session_exchange' | 'contradicted_by';
export interface Edge {
    id: string;
    sourceId: string;
    targetId: string;
    type: EdgeType;
    weight: number;
    metadata: Record<string, unknown>;
}
export interface AgentIdentity {
    id: string;
    name: string;
    label: string;
    registeredAt: string;
    visibilityMask: number;
}
export interface ReadOptions {
    depth?: number;
    includeEdges?: boolean;
    includeChildren?: boolean;
    confidenceAbove?: number;
    visibilityMask?: number;
    showIrrelevant?: boolean;
}
export interface WriteOptions {
    id?: string;
    title?: string;
    parentId?: string | null;
    contentType?: ContentType;
    confidence?: number;
    decayRate?: number;
    visibility?: number;
    tags?: string[];
    edges?: Omit<Edge, 'id'>[];
    metadata?: Record<string, unknown>;
}
export interface DecayOptions {
    before: string;
    exclude?: string[];
}
export interface SearchOptions {
    query: string;
    topK?: number;
    searchType?: 'fts' | 'vector' | 'hybrid';
    confidenceAbove?: number;
    visibilityMask?: number;
}
export type SyncOperation = 'upsert' | 'delete';
export type SyncEntity = 'entry' | 'edge';
export interface StagingRecord {
    key: string;
    entityType: SyncEntity;
    operation: SyncOperation;
    payload: string;
    lwwTimestamp: number;
    lwwDevice: string;
    lwwConfidence: number;
    acked: boolean;
}
export { resolveLWW } from './lww.js';
export type { ConflictResolution } from './lww.js';
export interface MemoryInterface {
    read(id: string, options?: ReadOptions): Promise<Entry | null>;
    write(content: string, options?: WriteOptions): Promise<Entry>;
    update(id: string, patch: Partial<Entry>): Promise<Entry>;
    delete(id: string, hard?: boolean): Promise<void>;
    search(options: SearchOptions): Promise<Entry[]>;
    searchFts(query: string, limit?: number): Promise<Entry[]>;
    link(sourceId: string, targetId: string, type: EdgeType, weight?: number, metadata?: Record<string, unknown>): Promise<Edge>;
    getEdges(id: string, direction?: 'outgoing' | 'incoming' | 'both'): Promise<Edge[]>;
    traceChain(startId: string, edgeType?: EdgeType, depth?: number): Promise<Entry[]>;
    registerAgent(name: string, label: string): Promise<AgentIdentity>;
    getAgents(): Promise<AgentIdentity[]>;
    getStaging(cursor?: number): Promise<StagingRecord[]>;
    applyStaging(records: StagingRecord[]): Promise<void>;
    getStagingCursor(): Promise<number>;
    gcStaging(olderThanDays: number): Promise<number>;
    health(): Promise<HealthReport>;
    stats(): Promise<MemoryStats>;
    getContentStats(root?: string, kind?: string, buckets?: number[]): Promise<ContentStats>;
    deleteBatch(ids: string[], hard?: boolean): Promise<number>;
    suppress(pattern: string, reason: string, ttl?: string): Promise<void>;
    isSuppressed(content: string): Promise<boolean>;
    runDecay(options: DecayOptions): Promise<number>;
}
export interface MemoryStats {
    totalEntries: number;
    totalEdges: number;
    entriesByDepth: Record<number, number>;
    entriesByType: Record<string, number>;
    topTags: {
        tag: string;
        count: number;
    }[];
    avgConfidence: number;
    oldestEntry: string | null;
    newestEntry: string | null;
    staleCount: number;
}
export interface ContentStats {
    totalEntries: number;
    totalContentBytes: number;
    avgContentChars: number;
    maxContentChars: number;
    minContentChars: number;
    buckets: {
        threshold: string;
        count: number;
    }[];
    byKind: {
        kind: string;
        count: number;
        totalBytes: number;
    }[];
}
export type EventType = 'memory:written' | 'memory:updated' | 'memory:deleted' | 'edge:created' | 'edge:deleted' | 'sync:pushed' | 'sync:pulled' | 'agent:registered' | 'rem:decay' | 'rem:compress' | 'rem:health';
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
    promptSubmit?: {
        enabled?: boolean;
    };
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
        chain?: Array<{
            cli: string;
            model: string;
            provider?: string;
        }>;
        timeout_sec?: number;
        hard_timeout_ms?: number;
        maxCandidates?: number;
        topK?: number;
        minConfidence?: number;
        includeBatchSummaries?: boolean;
        searchType?: 'fts';
    };
    /** Throttled npm version check on session start (default true). */
    updateCheck?: boolean;
    /** ISO timestamp of last registry check (config cache). */
    updateCheckLastAt?: string;
    /** Auto-create projects for unbound directories (default true). */
    autoProject?: boolean;
    checkpoint?: {
        everyN?: number;
    };
    briefing?: {
        maxTokens?: number;
    };
}
export { type ProjectMetadata, type ResolveProjectResult, type SectionCandidate, type ResolveSectionResult, } from './project.js';
export { InProcessEventBus } from './event-bus.js';
export { loadConfig, saveConfig, getConfigPath, getTimDir, normalizeHookScripts, hooksEnabled, type HooksConfig, type RememberConfig, type TimConfigFile, } from './config.js';
export { readTimSessionCache, resolveActiveSessionId, timSessionCachePath, type TimSessionCache, } from './session-cache.js';
export { evaluateLoadGate } from './load-gate.js';
export { SCHEMA_KINDS } from './schema-kinds.js';
export { isStale, staleDays, daysSinceLastVerified } from './staleness.js';
//# sourceMappingURL=index.d.ts.map