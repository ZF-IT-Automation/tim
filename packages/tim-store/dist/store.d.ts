import Database from 'better-sqlite3';
import type { Entry, Edge, EdgeType, ReadOptions, WriteOptions, DecayOptions, SearchOptions, MemoryInterface, HealthReport, MemoryStats, AgentIdentity, StagingRecord, EventBus, ResolveProjectResult, ResolveSectionResult } from 'tim-core';
import { CurateManager } from './curate.js';
/**
 * Sanitize a user-supplied query string into a safe FTS5 MATCH expression.
 *
 * Problems this guards against (verified empirically against better-sqlite3 FTS5):
 *   1. `task:true` → "no such column: task"   (token:value parsed as column filter)
 *   2. `"foo AND bar"` literal text containing AND is a valid FTS5 operator,
 *      so users searching for "AND" or "OR" as words can collide with FTS5 syntax.
 *   3. Special chars `^ * ( ) " '` in raw input can throw `fts5: syntax error`.
 *
 * Strategy:
 *   - For `token:value` patterns, if `token` matches a real FTS5 column name
 *     (title, content, tags), pass through as-is. Otherwise, split into two
 *     tokens (the bogus "column" becomes a search term).
 *   - Drop FTS5 operator words (AND, OR, NOT, NEAR) case-insensitive.
 *   - Strip quotes/parens/carets/stars, replace with space.
 *   - Re-emit as `token1 token2` (implicit FTS5 AND).
 *   - Return empty string if no safe tokens survive — caller must skip the query.
 */
export declare function sanitizeFtsQuery(query: string): string;
export interface TimStoreOptions {
    emitter?: Pick<EventBus, 'emit'>;
    agentId?: string;
}
export interface CreateProjectOptions {
    content?: string;
    metadata?: Record<string, unknown>;
    /** Short names for tim_load_project (e.g. ["o9k", "hmem"]). Stored lowercase. */
    aliases?: string[];
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
    /**
     * Resolve a project label or alias to a canonical P-label.
     * Direct label/id lookup first, then metadata.aliases scan.
     */
    resolveProjectLabel(query: string): Promise<ResolveProjectResult>;
    /**
     * Resolve a section by (projectId, title) within a project root.
     *
     * Sections are direct children of a project root (kind=project, parent_id=NULL
     * typically, or any node whose metadata.label matches). Used by tim_write to
     * disambiguate `parentTitle="Tasks"` lookups — silently picking the first
     * match caused orphan writes under wrong/legacy sections.
     *
     * Returns a tagged union:
     *   - found:      exactly one match.
     *   - not_found:  zero matches; `candidates` lists the section titles that
     *                 DO exist under the project (helps the caller recover).
     *   - ambiguous:  multiple matches; `candidates` carries id+title+project+
     *                 depth+createdAt for each (caller re-issues with parentId).
     */
    resolveSectionByTitle(projectId: string, title: string): Promise<ResolveSectionResult>;
    /** Resolve label/alias/id to a project entry; throws on missing or ambiguous. */
    requireProject(projectId: string): Promise<Entry>;
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
    /**
     * Query root-level entries (parent_id IS NULL) that are not projects.
     * Filter by either:
     *   - `type`: exact match on `json_extract(metadata, '$.type')` (preferred)
     *   - `tag` : legacy string-tag match via JSON-LIKE (deprecated, kept
     *             for backward compatibility with the pre-Phase-0 hook)
     *
     * `type` takes precedence if both are supplied.
     */
    getRootLevelEntries(filter?: {
        type?: string;
        tag?: string;
    }): Entry[];
    getTasks(opts?: GetTasksOptions): Promise<TaskRecord[]>;
    private findProjectLabelForParent;
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