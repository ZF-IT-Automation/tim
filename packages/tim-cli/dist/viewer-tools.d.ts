import { type ToolInputSchema } from 'tim-mcp';
/**
 * Tools the viewer may call. Deliberately its own list rather than the server's
 * `READ_TOOLS`: that set exists to decide whether a call triggers an auto-pull
 * or an auto-push, and nothing in it was ever vetted as a security boundary.
 * Two of its members do not belong on a read-only surface —
 *
 *   tim_sync    talks to the sync server and pushes local state
 *   tim_export  writes a file to targetPath, or to a temp file when omitted
 *
 * — and inheriting the set would have quietly included both. Anything absent
 * here is denied, so a tool added to the server later stays out until someone
 * decides it belongs.
 */
export declare const INSPECTOR_TOOLS: ReadonlySet<string>;
/**
 * The write tools the viewer may call, kept deliberately tiny.
 *
 * Editing memory from the viewer is not the goal — fixing *structure* is: a node
 * that landed in the wrong place, or one that should not exist. Move and soft-delete
 * cover that and nothing else. No tool here can change what an entry says, so a
 * misclick loses a node's position, never its content.
 *
 * tim_update_many is on the list only for its `irrelevant` flag: deleting a subtree
 * means flagging every descendant, and the alternative is one HTTP round trip per
 * node. It cannot touch content either.
 */
export declare const MUTATION_TOOLS: ReadonlySet<string>;
export interface InspectorTool {
    name: string;
    description: string;
    inputSchema: ToolInputSchema;
    /** Arguments pinned by the viewer, shown so the override is not a secret. */
    forced?: Record<string, unknown>;
}
export declare function listInspectorTools(): InspectorTool[];
/**
 * The arguments actually sent for a call. Forced values are applied last, so a
 * form field of the same name cannot win — separated out so that precedence is
 * testable without a live server.
 */
export declare function inspectorToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown>;
/**
 * The database the MCP server is actually working on, read from tim_doctor's
 * first line. Exported for the test, which should not have to run a server to
 * check the parse.
 */
export declare function parseDoctorDbPath(text: string): string | null;
export declare class DatabaseMismatchError extends Error {
    constructor(viewerDb: string, serverDb: string);
}
/**
 * Refuse a mutation unless the MCP server holds the same database the viewer is
 * rendering.
 *
 * Reads never needed this: the tool panel exists precisely to show what an agent
 * sees, and a second database showing through it is informative rather than
 * dangerous. A delete button is different — without this check, editing a viewer
 * opened on one database silently rewrites whichever database happens to answer
 * on TIM_MCP_PORT, and the tree on screen never moves.
 */
export declare function assertSameDatabase(viewerDbPath: string, options?: {
    url?: string;
}): Promise<void>;
export declare class ToolNotAllowedError extends Error {
    constructor(name: string);
}
/** Default endpoint of `tim mcp --http`, matching TIM_MCP_PORT's default. */
export declare function defaultMcpUrl(): string;
/**
 * Call one read-only tool and return its text output verbatim.
 *
 * ponytail: one SSE connection per call. The server builds a fresh MCP server
 * per connection (server.ts:3415), so a hand-driven panel pays ~one init per
 * click — fine at click rate, and it means there is no stale-connection state
 * to reason about. Hold a lazy client if the panel ever fires in bulk.
 */
export declare function callInspectorTool(name: string, args: Record<string, unknown>, options?: {
    url?: string;
}): Promise<string>;
/**
 * Call one structure-editing tool. Same transport as the read path — the point of
 * going over the wire holds twice over here: the MCP server owns the writable
 * store, so the viewer's own handle stays read-only and there is exactly one
 * process that can change the database.
 */
export declare function callMutationTool(name: string, args: Record<string, unknown>, options?: {
    url?: string;
}): Promise<string>;
//# sourceMappingURL=viewer-tools.d.ts.map