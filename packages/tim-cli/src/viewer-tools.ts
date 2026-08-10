// The viewer's tool panel: read-only tim_* calls, routed to the running MCP
// server rather than executed in-process.
//
// Going over the wire is the point. Rendering a tool's output in-process would
// show what the viewer's own code produces; going through the server shows what
// an agent actually receives — same handler, same formatting, same store. A
// discrepancy between the two is exactly the class of bug the panel exists to
// catch, so it must not be defined away.

import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DEFS, toolInputSchema, type ToolInputSchema } from 'tim-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

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
export const INSPECTOR_TOOLS: ReadonlySet<string> = new Set([
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
const FORCED_ARGS: Record<string, Record<string, unknown>> = {
  tim_load_project: { bind: false },
};

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
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'tim_delete',
  'tim_move_entry',
  'tim_update_many',
]);

export interface InspectorTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** Arguments pinned by the viewer, shown so the override is not a secret. */
  forced?: Record<string, unknown>;
}

export function listInspectorTools(): InspectorTool[] {
  return TOOL_DEFS.filter(def => INSPECTOR_TOOLS.has(def.name) && !def.internal)
    .map(def => ({
      name: def.name,
      description: def.description,
      inputSchema: toolInputSchema(def.schema),
      ...(FORCED_ARGS[def.name] ? { forced: FORCED_ARGS[def.name] } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The arguments actually sent for a call. Forced values are applied last, so a
 * form field of the same name cannot win — separated out so that precedence is
 * testable without a live server.
 */
export function inspectorToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { ...args, ...(FORCED_ARGS[name] ?? {}) };
}

/**
 * The database the MCP server is actually working on, read from tim_doctor's
 * first line. Exported for the test, which should not have to run a server to
 * check the parse.
 */
export function parseDoctorDbPath(text: string): string | null {
  const match = /^TIM Doctor\s+—\s+(.+?)\s*$/m.exec(text);
  return match ? match[1]! : null;
}

export class DatabaseMismatchError extends Error {
  constructor(viewerDb: string, serverDb: string) {
    super(
      `Refusing to edit: the viewer is showing ${viewerDb}, but the MCP server at ` +
        `TIM_MCP_PORT is working on ${serverDb}. An edit would change a database you ` +
        `are not looking at. Point the viewer and the server at the same file, or set ` +
        `TIM_MCP_PORT to the server for this database.`,
    );
    this.name = 'DatabaseMismatchError';
  }
}

/** Cache per (server url, viewer db): neither path changes while a process lives. */
const dbCheckCache = new Map<string, Promise<void>>();

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
export async function assertSameDatabase(
  viewerDbPath: string,
  options: { url?: string } = {},
): Promise<void> {
  const url = options.url ?? defaultMcpUrl();
  const key = url + '\0' + viewerDbPath;
  let check = dbCheckCache.get(key);
  if (!check) {
    check = (async () => {
      const text = await callTool('tim_doctor', {}, { url });
      const serverDb = parseDoctorDbPath(text);
      // An unreadable answer is not a pass. If tim_doctor's format ever changes,
      // this fails closed rather than waving edits through unchecked.
      if (!serverDb) {
        throw new Error(
          'Cannot confirm which database the MCP server is using (tim_doctor gave no ' +
            'path), so the edit is refused rather than aimed at an unknown target.',
        );
      }
      if (real(serverDb) !== real(viewerDbPath)) {
        throw new DatabaseMismatchError(viewerDbPath, serverDb);
      }
    })();
    dbCheckCache.set(key, check);
  }
  try {
    await check;
  } catch (err) {
    // A failed check is not cached: the usual cause is the server being down or
    // pointed elsewhere, both of which the user can fix without a restart.
    dbCheckCache.delete(key);
    throw err;
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export class ToolNotAllowedError extends Error {
  constructor(name: string) {
    super(
      `Tool "${name}" is not callable from the viewer. The viewer runs two allowlists: ` +
        `read tools on GET /api/tool, and structure edits (move, soft-delete) on ` +
        `POST /api/mutate. Everything else — content writes, tim_sync, tim_export — is excluded.`,
    );
    this.name = 'ToolNotAllowedError';
  }
}

/** Default endpoint of `tim mcp --http`, matching TIM_MCP_PORT's default. */
export function defaultMcpUrl(): string {
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
export async function callInspectorTool(
  name: string,
  args: Record<string, unknown>,
  options: { url?: string } = {},
): Promise<string> {
  if (!INSPECTOR_TOOLS.has(name)) throw new ToolNotAllowedError(name);
  return callTool(name, args, options);
}

/**
 * Call one structure-editing tool. Same transport as the read path — the point of
 * going over the wire holds twice over here: the MCP server owns the writable
 * store, so the viewer's own handle stays read-only and there is exactly one
 * process that can change the database.
 */
export async function callMutationTool(
  name: string,
  args: Record<string, unknown>,
  options: { url?: string } = {},
): Promise<string> {
  if (!MUTATION_TOOLS.has(name)) throw new ToolNotAllowedError(name);
  return callTool(name, args, options);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  options: { url?: string },
): Promise<string> {
  const url = options.url ?? defaultMcpUrl();
  const client = new Client({ name: 'tim-viewer', version: '1' }, { capabilities: {} });

  try {
    await client.connect(new SSEClientTransport(new URL(url)));
  } catch (err) {
    throw new Error(
      `Cannot reach the TIM MCP server at ${url} (${(err as Error).message}). ` +
        `The tool panel and the edit buttons need it running — the tree does not.`,
    );
  }

  try {
    const result = await client.callTool({ name, arguments: inspectorToolArgs(name, args) });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map(part =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : JSON.stringify(part),
      )
      .join('\n');
    // isError is part of the answer: the panel shows the server's own error
    // text rather than a viewer-invented one.
    return result.isError ? `[tool reported an error]\n${text}` : text;
  } finally {
    await client.close().catch(() => {});
  }
}
