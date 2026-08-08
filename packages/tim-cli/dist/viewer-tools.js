"use strict";
// The viewer's tool panel: read-only tim_* calls, routed to the running MCP
// server rather than executed in-process.
//
// Going over the wire is the point. Rendering a tool's output in-process would
// show what the viewer's own code produces; going through the server shows what
// an agent actually receives — same handler, same formatting, same store. A
// discrepancy between the two is exactly the class of bug the panel exists to
// catch, so it must not be defined away.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolNotAllowedError = exports.INSPECTOR_TOOLS = void 0;
exports.listInspectorTools = listInspectorTools;
exports.inspectorToolArgs = inspectorToolArgs;
exports.defaultMcpUrl = defaultMcpUrl;
exports.callInspectorTool = callInspectorTool;
const tim_mcp_1 = require("tim-mcp");
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/client/sse.js");
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
exports.INSPECTOR_TOOLS = new Set([
    'tim_read',
    'tim_read_project',
    'tim_load_project',
    'tim_search',
    'tim_trace',
    'tim_show',
    'tim_section_children',
    'tim_project_structure',
    'tim_resume_list',
    'tim_preview_briefing',
    'tim_stats',
    'tim_health',
    'tim_doctor',
    'tim_dry_run_move',
    'tim_import_manifest',
    'tim_import_audit',
    'tim_show_unsummarized',
    'tim_show_all_unsummarized',
    'tim_show_untagged',
    'tim_hook_prompt_submit',
]);
/**
 * Arguments the viewer overrides no matter what the form says.
 *
 * tim_load_project defaults to bind:true, which starts a project session and
 * writes a .tim-project marker (server.ts gates both on `bind`). Pinning it off
 * here rather than trusting the form is the difference between a read-only
 * surface and one that happens to be read-only when the user leaves a checkbox
 * alone.
 */
const FORCED_ARGS = {
    tim_load_project: { bind: false },
};
function listInspectorTools() {
    return tim_mcp_1.TOOL_DEFS.filter(def => exports.INSPECTOR_TOOLS.has(def.name) && !def.internal)
        .map(def => ({
        name: def.name,
        description: def.description,
        inputSchema: (0, tim_mcp_1.toolInputSchema)(def.schema),
        ...(FORCED_ARGS[def.name] ? { forced: FORCED_ARGS[def.name] } : {}),
    }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * The arguments actually sent for a call. Forced values are applied last, so a
 * form field of the same name cannot win — separated out so that precedence is
 * testable without a live server.
 */
function inspectorToolArgs(name, args) {
    return { ...args, ...(FORCED_ARGS[name] ?? {}) };
}
class ToolNotAllowedError extends Error {
    constructor(name) {
        super(`Tool "${name}" is not callable from the viewer. The viewer runs a read-only ` +
            `allowlist; write tools, tim_sync and tim_export are excluded.`);
        this.name = 'ToolNotAllowedError';
    }
}
exports.ToolNotAllowedError = ToolNotAllowedError;
/** Default endpoint of `tim mcp --http`, matching TIM_MCP_PORT's default. */
function defaultMcpUrl() {
    const port = process.env.TIM_MCP_PORT ?? '3847';
    return `http://127.0.0.1:${port}/sse`;
}
/**
 * Call one read-only tool and return its text output verbatim.
 *
 * ponytail: one SSE connection per call. The server builds a fresh MCP server
 * per connection (server.ts:3415), so a hand-driven panel pays ~one init per
 * click — fine at click rate, and it means there is no stale-connection state
 * to reason about. Hold a lazy client if the panel ever fires in bulk.
 */
async function callInspectorTool(name, args, options = {}) {
    if (!exports.INSPECTOR_TOOLS.has(name))
        throw new ToolNotAllowedError(name);
    const url = options.url ?? defaultMcpUrl();
    const client = new index_js_1.Client({ name: 'tim-viewer', version: '1' }, { capabilities: {} });
    try {
        await client.connect(new sse_js_1.SSEClientTransport(new URL(url)));
    }
    catch (err) {
        throw new Error(`Cannot reach the TIM MCP server at ${url} (${err.message}). ` +
            `The tool panel needs it running — the tree does not.`);
    }
    try {
        const result = await client.callTool({ name, arguments: inspectorToolArgs(name, args) });
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
            .map(part => part && typeof part === 'object' && 'text' in part
            ? String(part.text)
            : JSON.stringify(part))
            .join('\n');
        // isError is part of the answer: the panel shows the server's own error
        // text rather than a viewer-invented one.
        return result.isError ? `[tool reported an error]\n${text}` : text;
    }
    finally {
        await client.close().catch(() => { });
    }
}
//# sourceMappingURL=viewer-tools.js.map