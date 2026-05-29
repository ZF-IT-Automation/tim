import type { Entry, Edge, EdgeType, ReadOptions, WriteOptions, SearchOptions, MemoryInterface, HealthReport, MemoryStats, AgentIdentity, StagingRecord } from 'tim-core';
export declare class TimStore implements MemoryInterface {
    private db;
    constructor(dbPath: string);
    close(): void;
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
    suppress(pattern: string, reason: string, ttl?: string): Promise<void>;
    isSuppressed(content: string): Promise<boolean>;
}
//# sourceMappingURL=store.d.ts.map