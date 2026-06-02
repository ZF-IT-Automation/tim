import Database from 'better-sqlite3';
import type { Entry, Edge, EdgeType, ReadOptions, WriteOptions, DecayOptions, SearchOptions, MemoryInterface, HealthReport, MemoryStats, AgentIdentity, StagingRecord, EventBus } from 'tim-core';
import { CurateManager } from './curate.js';
export interface TimStoreOptions {
    emitter?: Pick<EventBus, 'emit'>;
    agentId?: string;
}
export interface CreateProjectOptions {
    content?: string;
    metadata?: Record<string, unknown>;
}
export interface LoadProjectOptions {
    depth?: number;
    budget?: number;
    sections?: string[] | null;
}
export interface LoadProjectResult {
    project: Entry;
    children: Entry[];
    truncated: boolean;
}
export interface TaskRecord {
    id: string;
    title: string;
    content: string;
    parent_id: string | null;
    project_label: string | null;
    status: string | null;
    priority: string | null;
    due: string | null;
}
export interface GetTasksOptions {
    status?: string;
}
export declare class TimStore implements MemoryInterface {
    private db;
    private emitter?;
    private agentId;
    constructor(dbPath: string, options?: TimStoreOptions);
    private emit;
    read(id: string, options?: ReadOptions): Promise<Entry | null>;
    private loadChildrenRecursive;
    createProject(label: string, options?: CreateProjectOptions): Promise<Entry>;
    loadProject(label: string, options?: LoadProjectOptions): Promise<LoadProjectResult | null>;
    /**
     * Count sessions recorded under a project (by label or id). One session
     * entry (kind=session) is created per session start, so this is the
     * "sessions so far" count used to gate periodic project-summary generation.
     * Kinds are literals to avoid a session-tree → store import cycle.
     */
    countSessionSummaries(projectLabel: string): Promise<number>;
    getChildren(parentId: string, filter?: {
        metadataKind?: string;
    }): Promise<Entry[]>;
    /** Get all entries with a given metadata.kind value (no parent filter). */
    getByMetadataKind(kind: string, limit?: number): Promise<Entry[]>;
    getChildByKind(parentId: string, kind: string): Promise<Entry[]>;
    getChildrenBySeq(parentId: string): Promise<Entry[]>;
    getTasks(opts?: GetTasksOptions): Promise<TaskRecord[]>;
    private resolveProjectLabel;
    close(): void;
    curate(): CurateManager;
    /** @internal Exposed for tests */
    getDb(): Database.Database;
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
    suppress(pattern: string, reason: string, ttl?: string): Promise<void>;
    isSuppressed(content: string): Promise<boolean>;
    runDecay(options: DecayOptions): Promise<number>;
}
//# sourceMappingURL=store.d.ts.map