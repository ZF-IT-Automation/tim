# Plan 4: MCP Surface Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink and unify the agent-facing MCP tool surface: `bind:false` replaces `tim_read_project`, duplicate tools removed, plumbing tools hidden by default, ListTools schemas generated from zod (killing the drift), and a consistent error contract (`isError:true`, no `"null"` strings).

**Architecture:** Everything lives in `packages/tim-mcp/src/server.ts`. The zod schemas already exist for every tool — the hand-written JSON schemas in the ListTools handler are the duplication being deleted. New dependency: `zod-to-json-schema`.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, zod, zod-to-json-schema, Vitest.

## Global Constraints

- Backward compatibility for one release: removed/merged tools keep working as deprecated aliases (registered, marked `[DEPRECATED]` in the description) — EXCEPT `tim_rename_title` and `tim_tasks`, which are removed outright (both already have drop-in replacements: `tim_update(title)` and `tim_show what='tasks'`).
- The summarizer calls plumbing tools over MCP (`tim_write_batch_summary`, `tim_rollup_session_summary`, `tim_show_all_unsummarized`, `tim_error_log`, `tim_session_log`) — their HANDLERS must keep working unconditionally; only their ListTools VISIBILITY is gated.
- Update `docs/tim-mcp-reference.md` (if present; check `ls docs/`) and `docs/tim-capabilities.md` §5/§6 tool tables in the same commit as each surface change.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Execution order

Task 1 (error contract) first — later tasks reuse its helper. Then 2, 3, 4, 5 in order.

---

### Task 1: Consistent error contract — errorResult helper, kill the "null" strings

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` (helper near the top of `createMcpServer`; call sites at lines ~1751, ~1782, ~1788, ~2392-2400, ~2419-2432, ~2467-2481)
- Test: `packages/tim-mcp/src/__tests__/error-contract.test.ts` (new)

**Interfaces:**
- Produces: `function errorResult(text: string): { content: [{ type: 'text'; text: string }]; isError: true }`. Every failure path in the CallTool switch returns via it.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-mcp/src/__tests__/error-contract.test.ts`, following the harness pattern used by the existing tests in that directory (they spawn/connect a client to `createMcpServer` with a temp `TIM_DB_PATH` — copy the setup from `read-search-write-ext.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';
// ... setup boilerplate copied from read-search-write-ext.test.ts ...

describe('error contract', () => {
  it('tim_read of a missing id returns isError with a helpful message, not "null"', async () => {
    const res = await client.callTool({ name: 'tim_read', arguments: { id: 'NOPE-000' } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).not.toBe('null');
    expect(text).toContain('NOPE-000');
  });

  it('tim_load_project of a missing project returns isError', async () => {
    const res = await client.callTool({ name: 'tim_load_project', arguments: { label: 'P9999' } });
    expect(res.isError).toBe(true);
  });

  it('load-gate rejection returns isError', async () => {
    // Bind once, then attempt a different project — copy binding setup from
    // the existing load-gate test if one exists; otherwise create two
    // projects and a session, bind to the first, load the second.
    // Assertion: second call has isError === true.
  });
});
```

Fill the third test's setup from the existing load-gate coverage (grep `evaluateLoadGate` / `already bound` in `packages/tim-mcp/src/__tests__/`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-mcp && npx vitest run src/__tests__/error-contract.test.ts`
Expected: FAIL — `isError` undefined on those paths; tim_read returns `null`.

- [ ] **Step 3: Add the helper and convert the failure paths**

Inside `createMcpServer` (above the CallTool handler), add:

```typescript
  const errorResult = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    isError: true as const,
  });
```

Convert these paths (exhaustive list — grep to confirm no others return failure text without `isError`):
1. `tim_read` not-found paths (3× `JSON.stringify(null)` at ~1751/1782/1788) → `errorResult(\`Entry not found: ${id}\`)` (use the actual identifier variable in each branch; for the project/section variants name what wasn't found).
2. `tim_load_project`: `Ambiguous alias: ...` and `Project not found: ...` (2×) and the load-gate `Session already bound ...` return → wrap in `errorResult(...)`.
3. `tim_read_project`: same three patterns → `errorResult(...)`.
4. Sweep: `grep -n "content: \[{ type: 'text', text: \`" packages/tim-mcp/src/server.ts | grep -in "not found\|ambiguous\|failed\|invalid"` — wrap any hit that lacks `isError`.

- [ ] **Step 4: Run tests, full suite, commit**

Run: `npm run build && cd packages/tim-mcp && npx vitest run`
Expected: PASS. Existing tests asserting the old `"null"` text must be updated.

```bash
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/error-contract.test.ts
git commit -m "fix(tim-mcp): consistent error contract — isError:true, no null strings"
```

---

### Task 2: tim_load_project gains bind:false; tim_read_project becomes a deprecated alias

**Files:**
- Modify: `packages/tim-mcp/src/server.ts:328-343` (`TimLoadProjectSchema`, `TimReadProjectSchema`), ListTools entries (~1453-1491), handlers (`case 'tim_load_project'` ~2387, `case 'tim_read_project'` ~2464)
- Test: `packages/tim-mcp/src/__tests__/load-project-bind.test.ts` (new)

**Interfaces:**
- Produces: `tim_load_project(label, bind?: boolean = true, depth?, budget?, sections?)`. With `bind:false`: no load-gate check, no session binding, no marker sync; output rendered with the `'read'` render mode. `tim_read_project` stays registered, description prefixed `[DEPRECATED — use tim_load_project with bind:false]`, handler delegates.

- [ ] **Step 1: Write the failing test**

```typescript
// load-project-bind.test.ts — same client setup boilerplate as Task 1.
describe('tim_load_project bind:false', () => {
  it('does not bind the session and can be called for multiple projects', async () => {
    // create P9001 and P9002 via tim_create_project
    // call tim_load_project { label: 'P9001', bind: false }
    // call tim_load_project { label: 'P9002', bind: false }
    // both succeed (no "already bound" isError)
  });

  it('bind:false then bind:true works — read does not consume the gate', async () => {
    // tim_load_project { label: 'P9001', bind: false } → ok
    // tim_load_project { label: 'P9002' } (bind default true) → ok, binds
  });
});
```

Fill in the callTool plumbing from existing tests; assertions are `expect(res.isError).toBeFalsy()` plus output contains the project label.

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — `bind` is stripped/unknown, second bound-load path may reject depending on session state.

- [ ] **Step 3: Implement**

`TimLoadProjectSchema`: add `bind: z.boolean().default(true).describe('false = cross-project read without binding the session'),`.

Handler `case 'tim_load_project'`: destructure `bind`; when `bind === false`, skip (a) the `resolveActiveSessionId`/load-gate block, (b) the `startProjectSession` call, (c) `syncNearestProjectMarker`, and render with `formatProjectOutput(result, budget, loadProjectSchema(), 'read')`. When `bind === true`, behavior unchanged (`'load'` render mode).

Handler `case 'tim_read_project'`: replace its body with a delegation — parse with `TimReadProjectSchema`, then execute the same code path as `bind:false` (extract the shared logic into a local `async function loadProjectImpl(args: { label: string; depth?: number; budget?: number; sections?: string[] | null; bind: boolean })` used by both cases).

ListTools: update `tim_load_project` description to mention `bind:false`; add the `bind` property to its inputSchema; prefix `tim_read_project` description with `[DEPRECATED — use tim_load_project with bind:false] `.

- [ ] **Step 4: Run tests, update docs, commit**

Run: `npm run build && cd packages/tim-mcp && npx vitest run`
Update `docs/tim-capabilities.md` tool table. Also update `/home/bbbee/CLAUDE.md`-style guidance ONLY in repo docs (do not edit files outside the repo).

```bash
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/load-project-bind.test.ts docs/
git commit -m "feat(tim-mcp): tim_load_project bind:false replaces tim_read_project"
```

---

### Task 3: Remove tim_rename_title and tim_tasks

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` — remove `TimRenameTitleSchema` (~line 97), ListTools entries (`tim_rename_title` ~1099, `tim_tasks` ~1519), handlers (`case 'tim_rename_title'`, `case 'tim_tasks'` ~2512), and `TimTasksSchema`
- Modify: any tests referencing them (grep first)

- [ ] **Step 1: Inventory usage**

Run: `grep -rn "tim_rename_title\|tim_tasks" packages --include="*.ts" | grep -v dist` and `grep -rn "tim_rename_title\|tim_tasks" docs ~/projects/tim/*.md 2>/dev/null | head -20`
List hits. Tests get migrated (rename_title → `tim_update` with `title`; tasks → `tim_show what:'tasks'`); doc hits get updated in this task.

Note: the Overseer startup rule "Rufe nach dem Projekt-Load IMMER tim_tasks auf" lives in the USER's global CLAUDE.md outside the repo — flag this in the task report so Benni updates it to `tim_show what:'tasks'`; do not edit files outside the repo.

- [ ] **Step 2: Remove registrations, schemas, handlers**

Delete the four code blocks listed under Files. The `default:` case already answers unknown tools with `Unknown tool: <name>` + `isError:true` — that is the desired post-removal behavior.

- [ ] **Step 3: Migrate tests, run suite**

Run: `npm run build && cd packages/tim-mcp && npx vitest run && cd ../.. && npm test`
Expected: PASS after test migration.

- [ ] **Step 4: Update docs + commit**

Update tool tables/counts in `docs/tim-capabilities.md` (and CHANGELOG `[Unreleased]`: "Removed: tim_rename_title (use tim_update), tim_tasks (use tim_show)").

```bash
git add -A packages/tim-mcp docs CHANGELOG.md
git commit -m "feat(tim-mcp)!: remove tim_rename_title and deprecated tim_tasks"
```

---

### Task 4: Gate plumbing tools out of the default ListTools surface

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` (ListTools handler)
- Test: `packages/tim-mcp/src/__tests__/internal-tools-gate.test.ts` (new)

**Design:** The ListTools response filters out internal/plumbing tools unless `TIM_EXPOSE_INTERNAL_TOOLS=1`. CallTool handlers remain fully functional for hidden tools (the summarizer and hooks depend on them). Internal set:

```typescript
const INTERNAL_TOOLS = new Set([
  'tim_write_batch_summary',
  'tim_rollup_session_summary',
  'tim_show_unsummarized',
  'tim_show_all_unsummarized',
  'tim_show_untagged',
  'tim_error_log',
  'tim_session_log',
  'tim_checkpoint',
]);
```

(`tim_sync` stays visible — agents legitimately trigger sync — but see plan 6 for payload validation of its raw push. `tim_session_start` stays visible: hooks call it via agent context in some harnesses.)

- [ ] **Step 1: Write the failing test**

```typescript
// internal-tools-gate.test.ts — client setup boilerplate as before.
it('hides plumbing tools from ListTools by default', async () => {
  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name);
  expect(names).not.toContain('tim_write_batch_summary');
  expect(names).toContain('tim_read');
});

it('hidden tools still execute via CallTool', async () => {
  const res = await client.callTool({ name: 'tim_show_all_unsummarized', arguments: {} });
  expect(res.isError).toBeFalsy();
});

it('TIM_EXPOSE_INTERNAL_TOOLS=1 reveals them', async () => {
  // second server instance created with process.env.TIM_EXPOSE_INTERNAL_TOOLS = '1'
  // (set before createMcpServer; restore after)
  // expect names to contain 'tim_write_batch_summary'
});
```

- [ ] **Step 2: Implement**

In the ListTools handler, wrap the returned array:

```typescript
    const exposeInternal = process.env.TIM_EXPOSE_INTERNAL_TOOLS === '1';
    const visibleTools = exposeInternal
      ? allTools
      : allTools.filter(t => !INTERNAL_TOOLS.has(t.name));
    return { tools: visibleTools };
```

(`allTools` = the existing literal array, extracted to a variable.)

- [ ] **Step 3: Run tests + full suite + commit**

Note: any existing test that asserts the full tool count must be updated (count visible vs internal separately).

```bash
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/internal-tools-gate.test.ts
git commit -m "feat(tim-mcp): hide plumbing tools from ListTools (TIM_EXPOSE_INTERNAL_TOOLS=1 reveals)"
```

---

### Task 5: Generate ListTools inputSchemas from the zod schemas

**Files:**
- Modify: `packages/tim-mcp/package.json` (add `"zod-to-json-schema": "^3.24.0"`)
- Modify: `packages/tim-mcp/src/server.ts` (ListTools array)
- Test: `packages/tim-mcp/src/__tests__/schema-drift.test.ts` (new)

**Design:** Single source of truth = the zod schemas. Build a registry `TOOL_DEFS: Array<{ name; description; schema: z.ZodObject }>` and derive the ListTools array from it. Param descriptions move into `.describe()` calls on the zod fields. This kills the documented drift (`tim_write.title`, `tim_session_start.tool/model/taskSummary`, `tim_move_entry.order` exist in zod but were invisible to agents).

- [ ] **Step 1: Write the drift test first (it is the deliverable)**

```typescript
// schema-drift.test.ts
import { describe, it, expect } from 'vitest';
// import { TOOL_DEFS } from '../server.js'; // export it for the test

describe('ListTools schema drift', () => {
  it('every zod schema property appears in the generated inputSchema', () => {
    for (const def of TOOL_DEFS) {
      const json = zodToJsonSchema(def.schema, { target: 'openApi3' }) as {
        properties?: Record<string, unknown>;
      };
      const zodKeys = Object.keys(def.schema.shape);
      const jsonKeys = Object.keys(json.properties ?? {});
      expect(jsonKeys.sort()).toEqual(zodKeys.sort());
    }
  });
});
```

(With generation in place this is near-tautological — its real value is failing when someone reintroduces a hand-written schema. Keep it.)

- [ ] **Step 2: Install dependency**

Run: `cd packages/tim-mcp && npm install zod-to-json-schema` then verify `npm run build` still passes.

- [ ] **Step 3: Build the registry and convert**

Add near the schema definitions:

```typescript
import { zodToJsonSchema } from 'zod-to-json-schema';

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
}

function toListEntry(def: ToolDef) {
  return {
    name: def.name,
    description: def.description,
    inputSchema: zodToJsonSchema(def.schema, { target: 'openApi3' }) as {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    },
  };
}

export const TOOL_DEFS: ToolDef[] = [
  { name: 'tim_read', description: '…existing description…', schema: TimReadSchema },
  { name: 'tim_write', description: '…', schema: TimWriteSchema },
  // … one line per tool, in the current ListTools order, using the existing
  // Tim*Schema constants. Every tool in the ListTools array MUST appear here.
];
```

Then replace the hand-written ListTools array with `TOOL_DEFS.map(toListEntry)` (feeding the Task-4 visibility filter).

**Mechanical rule for descriptions:** for every property in the old hand-written inputSchema that had a `description`, add the identical text as `.describe('...')` on the corresponding zod field before deleting the hand-written block. Do this tool by tool; the old array is your checklist — nothing may be lost, only gained (params that existed in zod but not in the JSON schema become visible, which is the point).

Special case: `tim_remember` is conditionally registered (`rememberEnabled`) — keep the conditional by filtering `TOOL_DEFS` accordingly.

- [ ] **Step 4: Verify by diffing surfaces**

Write a throwaway script (scratchpad, not committed) that prints old vs new ListTools JSON per tool name and diff them. Expected differences ONLY: (a) previously-missing params now present, (b) representation details from zod-to-json-schema (e.g. `default` placement). Anything else = a lost description → fix.

- [ ] **Step 5: Run full suite + commit**

Run: `npm run build && npm test`
Expected: PASS (client-side tests don't validate schemas structurally, but any test asserting a description string must be checked).

```bash
git add packages/tim-mcp
git commit -m "refactor(tim-mcp): generate ListTools schemas from zod — kill schema drift"
```
