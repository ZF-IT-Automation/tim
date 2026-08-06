import Database from 'better-sqlite3';
export declare const REDACTED_TITLE = "[secret \u2014 redacted]";
interface EntryRow {
    id: string;
    parent_id: string | null;
    title: string | null;
    content: string;
    content_type: string;
    depth: number;
    confidence: number;
    created_at: string;
    accessed_at: string;
    updated_at: string;
    visibility: number;
    tags: string;
    irrelevant: number;
    favorite: number;
    tombstoned_at: string | null;
    metadata: string;
}
interface ParsedEntry {
    row: EntryRow;
    tags: string[];
    metadata: Record<string, unknown>;
}
export interface ViewerNode {
    id: string;
    parentId: string | null;
    title: string;
    kind: string | null;
    type: string | null;
    label: string | null;
    /** Raw metadata.render_depth — null when the node does not set one. */
    renderDepth: unknown;
    order: unknown;
    seq: unknown;
    batchIndex: unknown;
    taskStatus: string | null;
    tags: string[];
    contentChars: number;
    childCount: number;
    /** Children excluded by the store's read paths (irrelevant or tombstoned). */
    hiddenChildCount: number;
    secret: boolean;
    redacted: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface ViewerNodeDetail extends ViewerNode {
    content: string | null;
    contentType: string;
    metadata: Record<string, unknown>;
    depth: number;
    confidence: number;
    visibility: number;
    favorite: boolean;
    irrelevant: boolean;
    accessedAt: string;
    path: ViewerCrumb[];
}
export interface ViewerCrumb {
    id: string;
    title: string;
    kind: string | null;
    label: string | null;
}
export interface ViewerChildren {
    parent: ViewerNode;
    children: ViewerNode[];
}
export interface ViewerStats {
    databasePath: string;
    readOnly: boolean;
    /** Schema version recorded in the file. */
    schemaVersion: number;
    showSecrets: boolean;
    projectCount: number;
    totalEntries: number;
    hiddenEntries: number;
    secretEntries: number;
    edgeCount: number;
}
export interface ViewerDataOptions {
    /** When false (default) secret subtrees are structure-only. */
    showSecrets?: boolean;
}
export declare class ViewerData {
    private readonly db;
    private readonly showSecrets;
    private readonly databasePath;
    constructor(db: Database.Database, options?: ViewerDataOptions);
    /** Open the viewer's own read-only handle. Never migrates, never writes. */
    static open(dbPath: string, options?: ViewerDataOptions): ViewerData;
    getDb(): Database.Database;
    close(): void;
    /**
     * Resolve an entry by id, with the same label fallback store.read() has
     * (so "P0001" works as well as a raw entry id).
     */
    private readEntry;
    /**
     * Counted in one grouped query per batch of parents rather than a count
     * per node — a project's Exchanges subtree can be thousands wide.
     * `hidden` is what the store's read paths filter out (soft-deleted or
     * tombstoned): reported as a number so nothing is silently invisible.
     */
    private childCounts;
    private toNode;
    /** Entry points: every live entry with metadata.kind='project'. */
    listProjects(): ViewerNode[];
    /**
     * Children of `id` — all of them, in tree order. `id` may be an entry id
     * or a project label.
     */
    children(id: string): ViewerChildren | null;
    node(id: string): ViewerNodeDetail | null;
    /** Root-first breadcrumb, self excluded. */
    private ancestors;
    stats(): ViewerStats;
    /** Schema version recorded in the file (0 when the table is absent). */
    private schemaVersion;
}
/**
 * Tree order. store.getChildren() sorts by metadata.order, but the store
 * auto-assigns `order` from insertion sequence, while session turns and
 * batch summaries carry their own authoritative seq / batch_index. Those
 * win when present, so Exchanges → Batch N → turns reads in true
 * conversation order; created_at breaks remaining ties.
 */
export declare function sortChildren(children: ParsedEntry[]): ParsedEntry[];
export {};
//# sourceMappingURL=viewer-data.d.ts.map