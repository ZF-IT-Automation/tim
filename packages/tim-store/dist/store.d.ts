import Database from 'better-sqlite3';
import type { Entry, Edge, EdgeType, ReadOptions, WriteOptions, DecayOptions, SearchOptions, MemoryInterface, HealthReport, MemoryStats, ContentStats, AgentIdentity, StagingRecord, EventBus, ResolveProjectResult, ResolveSectionResult } from 'tim-core';
import { CurateManager } from './curate.js';
import { ConsolidationManager } from './consolidate.js';
/**
 * Sanitize a user-supplied query string into a safe FTS5 MATCH expression.
 *
 * Strategy: each whitespace-separated token is emitted as an FTS5 quoted
 * string (`"token"`). Inside the quotes FTS5 treats operators (AND/OR/
 * NOT/NEAR) and punctuation (`. / @ + % # -`) as literal text to
 * tokenize — the whole blocklist arms race disappears. Column filters
 * `title:`/`content:`/`tags:` survive as `column:"value"`.
 *
 * Trade-off: a user phrase originally quoted across spaces (`"foo bar"`)
 * degrades to `"foo" "bar"` (AND instead of phrase) — acceptable.
 * Tokens with no alphanumeric content are dropped (a fully-punctuation
 * quoted string would match nothing or error).
 */
export declare function sanitizeFtsQuery(query: string): string;
/**
 * Jaccard overlap of lowercase word-token sets. 1.0 = same word set.
 * Single-char tokens are dropped — they are almost always punctuation
 * noise ("v2", "a") and inflate similarity between unrelated titles.
 */
export declare function titleSimilarity(a: string, b: string): number;
export interface TimStoreOptions {
    emitter?: Pick<EventBus, 'emit'>;
    agentId?: string;
    /** Stable device id for LWW tiebreaks. Default 'local'. */
    deviceId?: string;
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
export interface RuleRecord {
    id: string;
    title: string;
    content: string;
    parent_id: string | null;
    project_label: string | null;
    trigger: string | null;
    action: string | null;
}
export interface BugRecord {
    id: string;
    title: string;
    content: string;
    parent_id: string | null;
    project_label: string | null;
    severity: string | null;
    status: string | null;
}
export interface GetBugsOptions {
    status?: string;
}
export interface GetTasksOptions {
    status?: string;
}
export declare class TimStore implements MemoryInterface {
    private db;
    private emitter?;
    private agentId;
    private deviceId;
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
    countSessionSummaries(projectLabel: string): Promise<number>;
    /** Count live descendants of a project node + latest created_at. */
    getProjectEntryStats(projectId: string): {
        count: number;
        lastActivity: string;
    };
    getChildren(parentId: string, filter?: {
        metadataKind?: string;
    }): Promise<Entry[]>;
    /** Get all entries with a given metadata.kind value (no parent filter). */
    getByMetadataKind(kind: string, limit?: number): Promise<Entry[]>;
    /**
     * Projects ordered by most recent session activity — used by the
     * tim_session_start Inbox fallback to offer a binding choice when no
     * `.tim-project` marker resolved. Groups kind=session entries by their
     * `project_ref` label and joins the project entry for its title; labels
     * whose project entry is deleted (soft or hard) drop out with the join.
     * The Inbox itself ('P0000' — literal to avoid a session-tree → store
     * import cycle) is excluded: falling back to it is what triggered the call.
     */
    recentActiveProjects(limit?: number): Promise<{
        label: string;
        title: string | null;
        lastActive: string;
    }[]>;
    /** Return which of the given entry IDs exist in the DB (single IN-query). */
    entryExistsBatch(ids: string[]): Promise<Set<string>>;
    /**
     * Recent batch-summary nodes (kind=batch-summary under session Summary trees).
     * Used by tim_remember for recency context.
     */
    getRecentBatchSummaries(options?: {
        limit?: number;
        maxAgeDays?: number;
        sessionId?: string;
        root?: string;
    }): Promise<Entry[]>;
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
    getBugs(opts?: GetBugsOptions): Promise<BugRecord[]>;
    getRules(): Promise<RuleRecord[]>;
    /** All project root nodes (kind='project'). Used for cross-project overview + name resolution. */
    listProjects(): Promise<Array<{
        id: string;
        label: string;
        title: string;
    }>>;
    /**
     * Entries carrying a tag. Tags stored as JSON array string → matched with
     * `tags LIKE '%"<tag>"%'`. `tag` is normalized: leading '#' kept as stored
     * (caller passes exact stored form, e.g. '#bug'). `limit` is an INTERNAL
     * safety cap (default 1000), NOT the user-facing limit.
     */
    getByTag(tag: string, limit?: number): Promise<Entry[]>;
    /** Entries where json_extract(metadata,'$.type') = type. `limit` internal cap (default 1000). */
    getByMetadataType(type: string, limit?: number): Promise<Entry[]>;
    /**
     * Public wrapper of findProjectLabelForParent.
     * Resolves the owning project label for ANY entry by walking parent_id up.
     * Returns null if the entry has no project ancestor.
     */
    getProjectLabel(entryId: string): string | null;
    private findProjectLabelForParent;
    close(): void;
    curate(): CurateManager;
    consolidate(): ConsolidationManager;
    /** @internal Exposed for tests */
    getDb(): Database.Database;
    /** Run `fn` inside a single exclusive DB transaction (serializes concurrent callers). */
    runExclusive<T>(fn: () => T): T;
    /** Synchronous write for use inside `runExclusive` transactions. */
    writeSync(content: string, options?: WriteOptions): Entry;
    getChildByKindSync(parentId: string, kind: string): Entry[];
    getChildrenBySeqSync(parentId: string): Entry[];
    /** Entries whose metadata JSON has non-boolean values for known boolean keys (legacy 1/0/"true"/"false"). */
    findEntriesWithNonBooleanTask(): Array<{
        id: string;
        metadata: string;
    }>;
    /**
     * One-shot migration: coerce legacy boolean metadata primitives to real booleans.
     * @returns counts of found / updated / skipped rows
     */
    reconcileMetadataTypes(options?: {
        dryRun?: boolean;
    }): Promise<{
        found: number;
        updated: number;
        skipped: number;
    }>;
    private buildEntryRow;
    private insertEntrySync;
    private insertStagingSync;
    write(content: string, options?: WriteOptions): Promise<Entry>;
    update(id: string, patch: Partial<Entry>): Promise<Entry>;
    delete(id: string, hard?: boolean): Promise<void>;
    /** Hard/soft delete multiple ids in one transaction; skips missing or tombstoned ids. */
    deleteBatch(ids: string[], hard?: boolean): Promise<number>;
    private deleteEntrySync;
    search(options: SearchOptions): Promise<Entry[]>;
    /**
     * Deterministic usage boost on top of FTS order: an entry's score is its
     * FTS position minus 2·log2(1 + referencedCount); ascending. Referenced
     * 1× → +2 positions, 3× → +4, 7× → +6. No wall-clock, no randomness.
     */
    private rankByUsage;
    /**
     * Hybrid re-rank combining three signals:
     *   1. FTS5 position (the raw order)
     *   2. Cosine similarity (embedding distance to query vector)
     *   3. Graph/usage/staleness boost (from Plan 8/10)
     */
    private rankByHybrid;
    searchFts(query: string, limit?: number): Promise<Entry[]>;
    /**
     * Near-duplicate candidates for a title, for the tim_write dedup gate.
     * FTS narrows to plausible candidates; Jaccard token overlap on the
     * title decides. Suppressed/irrelevant/tombstoned entries are already
     * excluded by searchFts.
     */
    findSimilar(title: string, opts?: {
        projectLabel?: string;
        threshold?: number;
        limit?: number;
    }): Promise<Array<{
        id: string;
        title: string;
        similarity: number;
    }>>;
    /**
     * Negative-memory lookup for the tim_guard pre-action check: FTS over
     * the query, filtered to failure knowledge (kind error/learning, or
     * #error/#learning tagged). Over-fetches because most FTS hits are not
     * failures. Plain-language actions are split into keywords (OR semantics)
     * because FTS5 AND-matching every token is too strict for guard queries.
     */
    searchFailures(query: string, opts?: {
        projectLabel?: string;
        limit?: number;
    }): Promise<Entry[]>;
    /**
     * All entries in the project subtree touched since the cutoff, for the
     * tim_delta session briefing supplement. Tombstoned entries appear as
     * "deleted" (their reads are otherwise filtered). Capped at 500 —
     * beyond that, a delta is no longer a briefing.
     */
    getChangedSince(projectId: string, sinceIso: string): Promise<{
        created: Entry[];
        updated: Entry[];
        deleted: Entry[];
    }>;
    /** Newest session entry in the project subtree, excluding the current session. */
    getPreviousSession(projectId: string, excludeSessionId?: string | null): Promise<Entry | null>;
    link(sourceId: string, targetId: string, type: EdgeType, weight?: number, metadata?: Record<string, unknown>): Promise<Edge>;
    unlink(edgeId: string): Promise<void>;
    getEdges(id: string, direction?: 'outgoing' | 'incoming' | 'both'): Promise<Edge[]>;
    traceChain(startId: string, edgeType?: EdgeType, depth?: number): Promise<Entry[]>;
    registerAgent(name: string, label: string): Promise<AgentIdentity>;
    getAgents(): Promise<AgentIdentity[]>;
    getStaging(cursor?: number): Promise<StagingRecord[]>;
    applyStaging(records: StagingRecord[]): Promise<void>;
    getStagingCursor(): Promise<number>;
    gcStaging(olderThanDays: number): Promise<number>;
    private usageGcDone;
    /** Record that these entries were surfaced to the agent (read or search hit). */
    recordRead(entryIds: string[], sessionId: string | null): void;
    /**
     * Mark previously-read entries as actually used (linked, updated, or
     * cited in a later write). Only flips rows of the same session — a
     * reference without a prior read in that session is not a retrieval win.
     */
    markReferenced(entryIds: string[], sessionId: string | null): number;
    getSessionReadIds(sessionId: string): string[];
    getReferenceCounts(entryIds: string[]): Map<string, number>;
    /**
     * Entries that need embedding (no vector yet, newest content first).
     * Schema kinds (sessions, sections, …) are skipped — they don't need
     * semantic search.
     */
    getUnembedded(count: number): Promise<Entry[]>;
    /** Store an embedding vector for an entry. Upserts — second call replaces. */
    setVectors(entryId: string, vector: Float32Array, model: string): void;
    health(): Promise<HealthReport>;
    stats(): Promise<MemoryStats>;
    getContentStats(root?: string, kind?: string, buckets?: number[]): Promise<ContentStats>;
    /**
     * Re-confirm entries as still valid without editing them. Stamps
     * metadata.verified_at and bumps updated_at (a verification is a
     * meaningful, syncable change — the staging upsert carries it to
     * other devices). Staleness elsewhere is verified_at ?? updated_at.
     */
    touchVerified(ids: string[]): Promise<{
        verified: string[];
        missing: string[];
    }>;
    suppress(pattern: string, reason: string, ttl?: string): Promise<void>;
    isSuppressed(content: string): Promise<boolean>;
    /** Active (non-expired) suppress patterns, lowercased. Loaded once per retrieval call. */
    private loadActiveSuppressPatterns;
    private static matchesSuppressed;
    runDecay(options: DecayOptions): Promise<number>;
}
export interface GoldenQuery {
    query: string;
    expectedIds: string[];
}
export interface BenchmarkResult {
    query: string;
    precisionAt3: number;
    recallAt5: number;
    mrr: number;
    found: string[];
    missing: string[];
}
export declare function runBenchmark(store: TimStore, queries: GoldenQuery[]): Promise<BenchmarkResult[]>;
export declare function splitTitleBody(content: string, explicitTitle?: string): {
    title: string;
    body: string;
};
/** Cosine similarity between two same-length vectors. Range: [-1, 1]. */
export declare function cosineSimilarity(a: Float32Array, b: Float32Array): number;
//# sourceMappingURL=store.d.ts.map