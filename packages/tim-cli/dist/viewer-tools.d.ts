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
//# sourceMappingURL=viewer-tools.d.ts.map