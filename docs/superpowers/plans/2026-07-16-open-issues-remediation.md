# Open Issues Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issues #3–#8 and eliminate stale-marker/test leakage, including `bind:false` marker mutation.

**Architecture:** Independent marker, Inbox, and search tracks run in isolated worktrees, receive separate reviews, and are integrated marker-first. Installer, CLI cleanup, and Claude hook delivery then run serially because they share CLI and setup surfaces.

**Tech Stack:** TypeScript, Node.js 24, SQLite/better-sqlite3, Zod, Vitest, MCP stdio, Bash hook adapters.

---

## Worktree and integration rules

- Integration worktree: `/home/bbbee/projects/tim/.worktrees/fix-open-issues`, branch `fix/open-issues`.
- Parallel branches start from `1eccf19`: `fix/marker-safety`, `fix/inbox-repair`, `fix/bounded-search`.
- Each implementer follows TDD and commits only its assigned files.
- Specification review precedes quality review. Integrate with `git cherry-pick <sha>` only after both approve.
- Integrate marker safety first. Create every later branch from the then-current `fix/open-issues` HEAD.

### Task 1: Isolate stdio MCP tests from repository markers

**Files:**
- Create: `packages/tim-mcp/src/__tests__/helpers/stdio-test-server.ts`
- Modify: `packages/tim-mcp/src/__tests__/error-contract.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/hmem-golden-e2e.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/import-audit-tools.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/initialize-handshake.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/internal-tools-gate.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/load-project-bind.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/mcp-resilience.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/mcp-sync-lease.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/metadata-roundtrip.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/read-depth-defaults.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/read-search-write-ext.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/recall-tools.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/server-http.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/show-output.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/stats-output.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/summary-read.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/suppress-retrieval-e2e.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/tag-deprecation.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/test-tim-stats-delete-tools.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/test_tim_rename_title.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/test_tim_update_content.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/test_tim_update_no_title.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/test_tim_update_title.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/usage-wiring.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/verify-tool.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/write-dedup.test.ts`
- Focus test: `packages/tim-mcp/src/__tests__/error-contract.test.ts`

- [ ] **Step 1: Add the failing repository-marker regression**

Add a test around the existing P8001 load-gate scenario. Snapshot a sentinel outside the child cwd and require it to remain byte-identical:

```ts
it('never mutates a marker outside the subprocess workspace', async () => {
  const sentinel = path.join(repoRoot, '.tim-project');
  const before = fs.existsSync(sentinel) ? fs.readFileSync(sentinel) : null;
  await client.callTool('tim_create_project', { label: 'P8001', content: 'A' });
  await client.callTool('tim_load_project', {
    label: 'P8001',
    sessionId: 'error-contract-session',
  });
  const after = fs.existsSync(sentinel) ? fs.readFileSync(sentinel) : null;
  expect(after).toEqual(before);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/error-contract.test.ts`

Expected: existing load-gate test fails without an ambient marker, or sentinel changes when executed from a checkout containing a marker.

- [ ] **Step 3: Add an isolated subprocess helper**

```ts
export interface StdioTestWorkspace {
  cwd: string;
  dbPath: string;
  cleanup(): void;
}

export function createStdioTestWorkspace(prefix: string): StdioTestWorkspace {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const dbPath = path.join(cwd, 'tim.db');
  return {
    cwd,
    dbPath,
    cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
}

export function spawnStdioServer(serverPath: string, workspace: StdioTestWorkspace) {
  return spawn(process.execPath, [serverPath], {
    cwd: workspace.cwd,
    env: {
      ...process.env,
      TIM_DB_PATH: workspace.dbPath,
      TIM_MARKER_MAX_ROOT: workspace.cwd,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
```

Update each stdio test client to own one workspace, spawn through the helper, and call `workspace.cleanup()` after the child exits. HTTP tests keep their explicit transport setup but also receive an isolated `cwd` when they spawn the server.

- [ ] **Step 4: Make load-gate identity explicit**

Use the same explicit `sessionId` on both calls:

```ts
const sessionId = 'error-contract-session';
await client.callTool('tim_load_project', { label: 'P8001', sessionId });
const second = await client.callTool('tim_load_project', { label: 'P8002', sessionId });
expect(second.result!.isError).toBe(true);
```

- [ ] **Step 5: Verify GREEN and isolation coverage**

Run:

```bash
npm run build
npx vitest run packages/tim-mcp/src/__tests__/error-contract.test.ts packages/tim-mcp/src/__tests__/load-project-bind.test.ts packages/tim-mcp/src/__tests__/hmem-golden-e2e.test.ts
rg -L "cwd:" packages/tim-mcp/src/__tests__/*.test.ts
```

Expected: selected tests pass; any remaining stdio-spawn file reported by the final command is migrated before commit.

- [ ] **Step 6: Commit**

```bash
git add packages/tim-mcp/src/__tests__
git commit -m "test(mcp): isolate stdio server working directories"
```

### Task 2: Make project reads marker-safe and reject stale directives

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` (`tim_load_project` handler)
- Modify: `packages/tim-cli/src/cli.ts` (`cmdResolveProject`)
- Modify: `packages/tim-hooks/src/marker.ts`
- Modify: `packages/tim-hooks/src/index.ts`
- Test: `packages/tim-mcp/src/__tests__/load-project-bind.test.ts`
- Test: `packages/tim-cli/src/__tests__/resolve-project.test.ts`
- Test: `packages/tim-hooks/src/__tests__/marker.test.ts`

- [ ] **Step 1: Add RED tests for read-only marker behavior**

Create a marker in the test workspace, save bytes and `mtimeMs`, call `tim_load_project` with `bind:false`, then assert both are unchanged. Repeat through `tim_read_project`.

```ts
const before = fs.readFileSync(markerPath);
const beforeMtime = fs.statSync(markerPath).mtimeMs;
await client.callTool('tim_load_project', { label: 'P8101', bind: false });
expect(fs.readFileSync(markerPath)).toEqual(before);
expect(fs.statSync(markerPath).mtimeMs).toBe(beforeMtime);
```

Add a CLI test whose marker names P0099 while the temporary DB lacks P0099:

```ts
const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], env);
expect(out).toContain('stale TIM project marker P0099');
expect(out).not.toContain('tim_load_project(label="P0099")');
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/load-project-bind.test.ts packages/tim-cli/src/__tests__/resolve-project.test.ts`

Expected: marker bytes/mtime change and stale directive still instructs a load.

- [ ] **Step 3: Guard marker synchronization by binding intent**

```ts
if (bind && cwd) {
  try {
    syncNearestProjectMarker(cwd, projectLabel, { sessionId });
  } catch {
    // Brief loading succeeded; marker refresh remains best-effort.
  }
}
```

- [ ] **Step 4: Add and use a stale-marker directive**

```ts
export function buildStaleMarkerDirective(projectLabel: string, markerDir: string): string {
  return [
    `⚠️ stale TIM project marker ${projectLabel} in ${markerDir}.`,
    `The configured TIM store has no matching project.`,
    `ACTION: repair explicitly with tim bind-project --label <existing-label> --cwd ${markerDir}.`,
    `Do not call tim_load_project for ${projectLabel}.`,
  ].join('\n');
}
```

In `cmdResolveProject`, call `validateMarkerAgainstStore(marker, store)` before `resolveProjectBindingLabel`. Emit `buildStaleMarkerDirective` when validation returns null; otherwise emit the normal directive with the canonical validated label.

- [ ] **Step 5: Verify GREEN**

Run: `npm run build && npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts packages/tim-cli/src/__tests__/resolve-project.test.ts packages/tim-mcp/src/__tests__/load-project-bind.test.ts packages/tim-mcp/src/__tests__/error-contract.test.ts`

Expected: all pass and no marker outside temporary workspaces changes.

- [ ] **Step 6: Commit**

```bash
git add packages/tim-mcp/src/server.ts packages/tim-cli/src/cli.ts packages/tim-hooks/src packages/tim-mcp/src/__tests__ packages/tim-cli/src/__tests__
git commit -m "fix: prevent stale and read-only project marker writes"
```

### Task 3: Repair reserved P0000 instead of reinserting

**Files:**
- Modify: `packages/tim-store/src/session-tree.ts` (`ensureInboxProject`)
- Test: `packages/tim-store/src/__tests__/session.test.ts`

- [ ] **Step 1: Add table-driven RED tests**

Seed P0000 through `store.writeSync` with faulty metadata/tags, including a tombstoned row via `store.updateSync('P0000', { tombstonedAt: ... })`. Assert repair preserves content and custom metadata while enforcing system invariants.

```ts
const repaired = await ensureInboxProject(store);
expect(repaired.id).toBe('P0000');
expect(repaired.content).toContain('legacy inbox text');
expect(repaired.metadata).toMatchObject({
  custom: 'keep', kind: 'project', label: 'P0000', is_system: true, render_depth: 1,
});
expect(repaired.irrelevant).toBe(false);
expect(repaired.tombstonedAt).toBeNull();
expect(new Set(repaired.tags)).toEqual(new Set(['#legacy', '#project', '#inbox', '#system']));
```

Call `Promise.all([ensureInboxProject(store), ensureInboxProject(store)])`, then query `entries WHERE id='P0000'` and assert count 1 and one final staged upsert.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run packages/tim-store/src/__tests__/session.test.ts -t ensureInboxProject`

Expected: `UNIQUE constraint failed: entries.id` for malformed existing P0000.

- [ ] **Step 3: Implement one exclusive create-or-repair transaction**

```ts
export async function ensureInboxProject(store: TimStore): Promise<Entry> {
  return store.runExclusive(() => {
    const existing = store.getDb().prepare('SELECT id FROM entries WHERE id = ?').get(INBOX_PROJECT_LABEL);
    if (!existing) {
      return store.writeSync('Inbox', {
        id: INBOX_PROJECT_LABEL,
        metadata: { kind: 'project', label: INBOX_PROJECT_LABEL, is_system: true, render_depth: 1 },
        tags: ['#project', '#inbox', '#system'],
      });
    }
    const entry = store.readIncludingTombstoneSync(INBOX_PROJECT_LABEL);
    if (!entry) throw new Error('P0000 disappeared during exclusive repair');
    return store.updateSync(INBOX_PROJECT_LABEL, {
      metadata: { ...entry.metadata, kind: 'project', label: INBOX_PROJECT_LABEL, is_system: true, render_depth: 1 },
      tags: [...new Set([...entry.tags, '#project', '#inbox', '#system'])],
      irrelevant: false,
      tombstonedAt: null,
    });
  });
}
```

Implement the noted row-read helper inside `TimStore` as `readIncludingTombstoneSync(id)` returning `Entry | null`; do not expose raw row conversion from `session-tree.ts`.

```ts
readIncludingTombstoneSync(id: string): Entry | null {
  const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
  return row ? rowToEntry(row) : null;
}
```

- [ ] **Step 4: Verify GREEN and rollback**

Run: `npx vitest run packages/tim-store/src/__tests__/session.test.ts packages/tim-store/src/__tests__/sync-lifecycle.test.ts`

Expected: repair, idempotency, concurrency, staging, and session-start tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session-tree.ts packages/tim-store/src/store.ts packages/tim-store/src/__tests__/session.test.ts
git commit -m "fix(store): repair malformed Inbox project in place"
```

### Task 4: Bound `tim_search` output

**Files:**
- Create: `packages/tim-mcp/src/search-response.ts`
- Modify: `packages/tim-mcp/src/server.ts`
- Modify: `packages/tim-mcp/scripts/migrate_v3_types.py`
- Test: `packages/tim-mcp/src/__tests__/stats-output.test.ts`
- Create: `packages/tim-mcp/src/__tests__/search-response.test.ts`

- [ ] **Step 1: Add RED size and compatibility tests**

```ts
it('keeps serialized search output within 24 KiB', () => {
  const entries = Array.from({ length: 100 }, (_, i) => fakeEntry(i, '🙂'.repeat(100_000)));
  const payload = buildSearchResponse(entries, { excerptChars: 500, maxBytes: 24 * 1024 });
  expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(24 * 1024);
  expect(payload.truncated).toBe(true);
  expect(payload.returned + payload.omitted).toBe(100);
});
```

Add an MCP test asserting the response is `{results, returned, omitted, truncated}`, result content is excerpted, metadata retains `kind` and `label`, and `tim_read` still returns the complete body.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run packages/tim-mcp/src/__tests__/search-response.test.ts packages/tim-mcp/src/__tests__/stats-output.test.ts`

Expected: helper is missing and current handler returns a raw unbounded array.

- [ ] **Step 3: Implement the bounded DTO**

```ts
export const SEARCH_RESPONSE_MAX_BYTES = 24 * 1024;
export const SEARCH_EXCERPT_CHARS = 500;

export interface SearchHitDto {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export function buildSearchResponse(entries: Entry[], options = {}) {
  const maxBytes = options.maxBytes ?? SEARCH_RESPONSE_MAX_BYTES;
  const results: SearchHitDto[] = [];
  for (const entry of entries) {
    const hit = {
      id: entry.id,
      title: entry.title,
      excerpt: truncateCodePoints(entry.content, options.excerptChars ?? SEARCH_EXCERPT_CHARS),
      tags: entry.tags,
      metadata: pickSearchMetadata(entry.metadata),
    };
    const candidate = { results: [...results, hit], returned: results.length + 1, omitted: entries.length - results.length - 1, truncated: true };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) break;
    results.push(hit);
  }
  return { results, returned: results.length, omitted: entries.length - results.length, truncated: results.length < entries.length };
}
```

`pickSearchMetadata` keeps `kind`, `label`, `type`, `status`, `project_ref`, and task metadata. `truncateCodePoints` uses `Array.from(text)` so surrogate pairs are never split. Reserve 512 bytes before accepting a hit so counters always fit.

Change the handler to `formatToolResponse(buildSearchResponse(results))`. Update Python discovery to use `payload.get("results", [])` for objects while accepting legacy arrays during migration.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run packages/tim-mcp/src/__tests__/search-response.test.ts packages/tim-mcp/src/__tests__/stats-output.test.ts && python3 -m py_compile packages/tim-mcp/scripts/migrate_v3_types.py`

Expected: all pass; UTF-8 payload never exceeds 24 KiB.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-mcp/src/search-response.ts packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__ packages/tim-mcp/scripts/migrate_v3_types.py
git commit -m "fix(mcp): bound search response payloads"
```

### Task 5: Generate executable MCP configurations

**Files:**
- Create: `packages/tim-cli/src/mcp-command.ts`
- Modify: `packages/tim-cli/src/install.ts`
- Modify: `packages/tim-cli/src/setup-agent.ts`
- Test: `packages/tim-cli/src/__tests__/install.test.ts`
- Test: `packages/tim-cli/src/__tests__/setup-agent.test.ts`

- [ ] **Step 1: Add RED resolver/config tests**

```ts
const entry = buildTimMcpEntry('/tmp/tim.db', { serverPath });
expect(entry).toEqual({
  command: process.execPath,
  args: [serverPath],
  env: { TIM_DB_PATH: '/tmp/tim.db' },
});
expect(fs.existsSync(entry.args[0])).toBe(true);
```

Assert a missing override throws before config creation and that paths containing spaces survive JSON and TOML generation. Spawn the generated entry, perform MCP `initialize`, then call `tim_stats`.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run packages/tim-cli/src/__tests__/install.test.ts packages/tim-cli/src/__tests__/setup-agent.test.ts`

Expected: generated command is still `npx tim-mcp`.

- [ ] **Step 3: Implement one verified resolver**

```ts
export function resolveTimMcpServerPath(options: { override?: string } = {}): string {
  const candidates = [
    options.override ?? process.env.TIM_MCP_SERVER,
    fileURLToPath(new URL('../../tim-mcp/dist/server.js', import.meta.url)),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`TIM MCP server artifact not found: ${candidates.join(', ')}`);
  return path.resolve(found);
}

export function buildTimMcpEntry(dbPath: string, options = {}): McpServerEntry {
  return { command: process.execPath, args: [resolveTimMcpServerPath(options)], env: { TIM_DB_PATH: dbPath } };
}
```

Resolve the entry once before creating directories, backups, or files. Pass the same entry to JSON, OpenCode, and Codex formatters.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/install.test.ts packages/tim-cli/src/__tests__/setup-agent.test.ts`

Expected: configs reference an existing absolute server and smoke initialization succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-cli/src/mcp-command.ts packages/tim-cli/src/install.ts packages/tim-cli/src/setup-agent.ts packages/tim-cli/src/__tests__
git commit -m "fix(cli): install executable TIM MCP commands"
```

### Task 6: Centralize CLI help and argument parsing

**Files:**
- Create: `packages/tim-cli/src/args.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Modify: `packages/tim-cli/src/setup-agent.ts`
- Test: `packages/tim-cli/src/__tests__/help-safety.test.ts`
- Create: `packages/tim-cli/src/__tests__/args.test.ts`

- [ ] **Step 1: Add RED help matrix and parser tests**

Test every command in the main switch with `-h` and `--help`; use a nonexistent/unwritable `TIM_DB_PATH` and assert exit 0 plus `Usage:` output. Add:

```ts
expect(parseArgs(['--name=value', '--dry-run'])).toEqual({ flags: { name: 'value', 'dry-run': 'true' }, positional: [] });
expect(parseArgs(['--', '--literal', 'x'])).toEqual({ flags: {}, positional: ['--literal', 'x'] });
expect(parseArgs(['--name', '--value'], { valueOptions: new Set(['name']) })).toEqual({ flags: { name: '--value' }, positional: [] });
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run packages/tim-cli/src/__tests__/help-safety.test.ts packages/tim-cli/src/__tests__/args.test.ts`

Expected: `resolve-project --help` is empty and parser module is missing.

- [ ] **Step 3: Implement parser and a pre-dispatch help gate**

```ts
export function parseArgs(args: string[], options: ParseOptions = {}): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let terminated = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!terminated && arg === '--') { terminated = true; continue; }
    if (!terminated && arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = arg.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) { flags[key] = arg.slice(eq + 1); continue; }
      const takeValue = options.valueOptions?.has(key) || (args[i + 1] && !args[i + 1].startsWith('--'));
      flags[key] = takeValue ? args[++i] : 'true';
    } else positional.push(arg);
  }
  return { flags, positional };
}
```

At the start of `main`, before the switch, handle help once:

```ts
if (hasHelpFlag(rest)) {
  printCommandHelp(cmd, rest[0]);
  return;
}
```

Add concrete usage text for every switch command and every `hook` subcommand. Remove duplicated per-case help checks and duplicate parsers from `cli.ts` and `setup-agent.ts`.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/args.test.ts packages/tim-cli/src/__tests__/help-safety.test.ts packages/tim-cli/src/__tests__/setup-agent.test.ts`

Expected: matrix and parser cases pass without DB/marker writes.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-cli/src/args.ts packages/tim-cli/src/cli.ts packages/tim-cli/src/setup-agent.ts packages/tim-cli/src/__tests__
git commit -m "fix(cli): make help and argument parsing consistent"
```

### Task 7: Remove author paths and use the shipped skill name

**Files:**
- Create: `packages/tim-hooks/scripts/lib/resolve-tim-cli.sh`
- Modify: `packages/tim-hooks/scripts/tim-claude-session-start.sh`
- Modify: `packages/tim-hooks/scripts/post-commit.sh`
- Modify: `packages/tim-hooks/scripts/tim-session-start.sh`
- Modify: `packages/tim-hooks/scripts/tim-post-commit.sh`
- Modify: `packages/tim-hooks/scripts/tim-hermes-session-cache.sh`
- Modify: `packages/tim-hooks/scripts/tim-hermes-statusline.sh`
- Modify: `packages/tim-hooks/scripts/tim-cursor-inject.sh`
- Modify: `packages/tim-hooks/scripts/tim-statusline.sh`
- Modify: `packages/tim-hooks/src/marker.ts`
- Modify: `packages/tim-hooks/README.md`
- Test: `packages/tim-hooks/src/__tests__/session-start-script.test.ts`
- Test: `packages/tim-hooks/src/__tests__/canonical-project.test.ts`

- [ ] **Step 1: Add RED scans and relocation test**

```ts
expect(allHookText).not.toMatch(/\/home\/bbbee\/projects\/tim/);
expect(buildLoadDirective('P0063', '/repo')).toContain('tim-session-start');
expect(buildLoadDirective('P0063', '/repo')).not.toContain('o9k-session-start');
```

Copy the session-start script and built packages under a temporary path containing spaces, clear `TIM_CLI`, prepend a fake installed `tim` to `PATH`, and assert the script emits a valid directive.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run packages/tim-hooks/src/__tests__/canonical-project.test.ts packages/tim-hooks/src/__tests__/session-start-script.test.ts`

Expected: hardcoded paths and stale skill name fail assertions.

- [ ] **Step 3: Add the shared shell resolver**

```bash
resolve_tim_cli() {
  if [[ -n "${TIM_CLI:-}" ]]; then printf '%s\n' "$TIM_CLI"; return; fi
  if command -v tim >/dev/null 2>&1; then command -v tim; return; fi
  local candidate="${SCRIPT_DIR}/../../tim-cli/dist/cli.js"
  [[ -f "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}
```

Source it from every hook script and execute either the discovered `tim` binary directly or `node "$candidate"` for a `.js` fallback. Replace generated directive text with `tim-session-start`; update portable README examples.

- [ ] **Step 4: Verify GREEN and scan**

Run:

```bash
npm run build
npx vitest run packages/tim-hooks/src/__tests__/canonical-project.test.ts packages/tim-hooks/src/__tests__/session-start-script.test.ts
rg -n "/home/bbbee|o9k-session-start" packages/tim-hooks packages/tim-cli docs README.md
```

Expected: tests pass; final scan has no shipped runtime instruction or script hit.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-hooks docs README.md
git commit -m "fix(hooks): make scripts relocatable and skill names canonical"
```

### Task 8: Expose `tim hook prompt-submit`

**Files:**
- Create: `packages/tim-cli/src/claude-hook-io.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Test: `packages/tim-cli/src/__tests__/prompt-submit-hook.test.ts`

- [ ] **Step 1: Add RED stdin/envelope tests**

Spawn the built CLI with a temporary DB and stdin `{ "session_id":"s1", "prompt":"sqlite WAL", "cwd":"<tmp>" }`. Assert exact output:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"TIM erinnert: ..."}}
```

Malformed JSON, empty prompt, disabled hook, timeout, and store errors must return exit 0 with no stdout.

- [ ] **Step 2: Verify RED**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/prompt-submit-hook.test.ts`

Expected: `Unknown hook: prompt-submit`.

- [ ] **Step 3: Implement bounded stdin and envelope helpers**

```ts
export async function readJsonStdin(maxBytes = 1024 * 1024): Promise<Record<string, unknown> | null> {
  let raw = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) return null;
    raw += text;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function promptSubmitEnvelope(context: string) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
}
```

Add the CLI case. Resolve only a cwd-local marker (`findMarker(cwd)` without walk-up), pass its project label to `runPromptSubmit`, and print the envelope only for non-null context. Catch all adapter errors and leave exit code 0.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/prompt-submit-hook.test.ts packages/tim-hooks/src/__tests__/prompt-submit.test.ts`

Expected: all pass, including Unicode and shell-character payloads.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-cli/src/claude-hook-io.ts packages/tim-cli/src/cli.ts packages/tim-cli/src/__tests__/prompt-submit-hook.test.ts
git commit -m "feat(cli): add Claude prompt-submit hook adapter"
```

### Task 9: Produce idempotent Claude Stop exchanges

**Files:**
- Create: `packages/tim-hooks/src/claude-stop.ts`
- Modify: `packages/tim-hooks/src/index.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Test: `packages/tim-hooks/src/__tests__/claude-stop.test.ts`
- Test: `packages/tim-cli/src/__tests__/claude-stop-hook.test.ts`

- [ ] **Step 1: Add RED transcript and duplicate tests**

Cover JSONL strings/content blocks, `isMeta`, tool-only messages, malformed lines, Unicode, 1 MiB bounds, missing sessions, and two identical Stop deliveries. The duplicate test must leave exchange counters unchanged on the second delivery.

```ts
const first = await runClaudeStop(store, payload, { cwd });
const second = await runClaudeStop(store, payload, { cwd });
expect(first.logged).toBe(true);
expect(second).toMatchObject({ logged: false, duplicate: true });
expect((await deriveCounters(store, payload.session_id)).exchangeCount).toBe(1);
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run packages/tim-hooks/src/__tests__/claude-stop.test.ts packages/tim-cli/src/__tests__/claude-stop-hook.test.ts`

Expected: modules and `claude-stop` subcommand are missing.

- [ ] **Step 3: Implement transcript extraction and deterministic identity**

```ts
export interface ClaudeStopResult { logged: boolean; duplicate?: boolean; exchangeCount?: number }

export async function runClaudeStop(store: TimStore, payload: ClaudeStopPayload, options: { cwd: string }): Promise<ClaudeStopResult> {
  const turn = readLastExchange(payload.transcript_path, MAX_TRANSCRIPT_BYTES);
  if (!turn) return { logged: false };
  const key = createHash('sha256').update(`${payload.session_id}\0${turn.identity}`).digest('hex');
  const sessions = new SessionManager(store);
  await ensureSessionForStop(sessions, payload.session_id, options.cwd);
  const logged = await sessions.logExchangeOnce(payload.session_id, key, [
    { role: 'user', content: bounded(turn.user) },
    { role: 'agent', content: bounded(turn.assistant) },
  ]);
  if (logged.length === 0) return { logged: false, duplicate: true };
  return { logged: true, ...(await afterExchangeLogged(store, payload.session_id, options.cwd)) };
}
```

Add `SessionManager.logExchangeOnce(sessionId, exchangeKey, entries)`. Extract the current synchronous body of `logExchange` into `logExchangeSync`; inside the existing `store.runExclusive`, first query:

```sql
SELECT 1 FROM entries
WHERE json_extract(metadata, '$.sessionId') = ?
  AND json_extract(metadata, '$.exchange_key') = ?
  AND tombstoned_at IS NULL
LIMIT 1
```

Return `[]` when found. Otherwise call `logExchangeSync` and merge `exchange_key` into the user and agent entry metadata. This makes duplicate check and writes atomic. `ensureSessionForStop` reads the cwd-local marker and calls `startProjectSession({ sessionId, projectId: marker.project, agentName: 'claude', cwd, harness: 'claude-code' })` only after the specific `Project session not found` condition.

- [ ] **Step 4: Add fail-soft CLI adapter**

`tim hook claude-stop` reads bounded stdin, requires cwd-local marker/session identity, calls `runClaudeStop`, emits no stdout for ignored/malformed payloads, and never recursively processes a Stop payload marked `stop_hook_active=true`.

- [ ] **Step 5: Verify GREEN and cadence**

Run: `npm run build && npx vitest run packages/tim-hooks/src/__tests__/claude-stop.test.ts packages/tim-cli/src/__tests__/claude-stop-hook.test.ts packages/tim-hooks/src/__tests__/session-hooks.test.ts`

Expected: duplicate delivery is idempotent; five distinct exchanges produce counters 1–5 and exactly one configured checkpoint.

- [ ] **Step 6: Commit**

```bash
git add packages/tim-hooks/src/claude-stop.ts packages/tim-hooks/src/index.ts packages/tim-hooks/src/__tests__ packages/tim-cli/src/cli.ts packages/tim-cli/src/__tests__/claude-stop-hook.test.ts
git commit -m "feat(hooks): log Claude Stop exchanges idempotently"
```

### Task 10: Install Claude hooks and remove model-driven logging

**Files:**
- Create: `packages/tim-cli/src/claude-hooks-install.ts`
- Modify: `packages/tim-cli/src/setup-agent.ts`
- Modify: `packages/tim-skills/src/tim-session-start.ts`
- Test: `packages/tim-cli/src/__tests__/setup-agent.test.ts`
- Create: `packages/tim-cli/src/__tests__/claude-hooks-install.test.ts`
- Modify: `packages/tim-skills/src/__tests__/skills.test.ts`

- [ ] **Step 1: Add RED settings-merge tests**

Start with unrelated settings and existing hooks. Assert both TIM commands are appended once and preserved across a second install:

```ts
expect(next.hooks.UserPromptSubmit).toContainEqual(expect.objectContaining({ command: expect.stringContaining('hook prompt-submit') }));
expect(next.hooks.Stop).toContainEqual(expect.objectContaining({ command: expect.stringContaining('hook claude-stop') }));
expect(next.permissions).toEqual(existing.permissions);
expect(installClaudeHooks(next)).toEqual(next);
```

Assert the shipped session-start skill no longer tells the model to call `tim_session_log`.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run packages/tim-cli/src/__tests__/claude-hooks-install.test.ts packages/tim-cli/src/__tests__/setup-agent.test.ts packages/tim-skills/src/__tests__/skills.test.ts`

Expected: Claude hooks are currently skipped and skill still requests internal logging.

- [ ] **Step 3: Implement stable merge and atomic write**

```ts
const TIM_PROMPT = { matcher: '', hooks: [{ type: 'command', command: 'tim hook prompt-submit', timeout: 2 }] };
const TIM_STOP = { matcher: '', hooks: [{ type: 'command', command: 'tim hook claude-stop', timeout: 5 }] };

function appendUnique<T extends { hooks: Array<{ command: string }> }>(existing: T[] | undefined, value: T): T[] {
  const items = existing ?? [];
  const command = value.hooks[0]?.command;
  return items.some(item => item.hooks.some(hook => hook.command === command))
    ? items
    : [...items, value];
}

export function mergeClaudeHooks(settings: ClaudeSettings): ClaudeSettings {
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      UserPromptSubmit: appendUnique(settings.hooks?.UserPromptSubmit, TIM_PROMPT),
      Stop: appendUnique(settings.hooks?.Stop, TIM_STOP),
    },
  };
}
```

Write `~/.claude/settings.json` through a same-directory temporary file plus rename, with a timestamped backup for existing valid JSON. Invalid JSON returns a skipped result without mutation. Wire real and dry-run `setup-agent --host claude` output to this installer. Replace the model logging instruction with a statement that installed hooks log exchanges automatically.

- [ ] **Step 4: Verify GREEN and E2E**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/claude-hooks-install.test.ts packages/tim-cli/src/__tests__/setup-agent.test.ts packages/tim-skills/src/__tests__/skills.test.ts packages/tim-cli/src/__tests__/prompt-submit-hook.test.ts packages/tim-cli/src/__tests__/claude-stop-hook.test.ts`

Expected: merge is idempotent, unrelated settings survive, both hook commands execute against temporary fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-cli/src/claude-hooks-install.ts packages/tim-cli/src/setup-agent.ts packages/tim-cli/src/__tests__ packages/tim-skills/src
git commit -m "feat(cli): install Claude prompt and Stop hooks"
```

### Task 11: Integrate, verify, and prepare issue closure evidence

**Files:**
- Modify only if verification exposes a regression in already-scoped files.
- Create: `docs/superpowers/reports/2026-07-16-open-issues-verification.md`

- [ ] **Step 1: Verify marker invariance around the full suite**

```bash
before=$(sha256sum .tim-project 2>/dev/null || true)
npm test
after=$(sha256sum .tim-project 2>/dev/null || true)
test "$before" = "$after"
```

Expected: full suite passes and marker digest is identical.

- [ ] **Step 2: Run build and lint**

Run: `npm run build && npm run lint`

Expected: both exit 0 with no TypeScript errors.

- [ ] **Step 3: Run targeted issue suites**

```bash
npx vitest run \
  packages/tim-mcp/src/__tests__/error-contract.test.ts \
  packages/tim-mcp/src/__tests__/load-project-bind.test.ts \
  packages/tim-store/src/__tests__/session.test.ts \
  packages/tim-mcp/src/__tests__/search-response.test.ts \
  packages/tim-cli/src/__tests__/install.test.ts \
  packages/tim-cli/src/__tests__/help-safety.test.ts \
  packages/tim-cli/src/__tests__/claude-hooks-install.test.ts \
  packages/tim-cli/src/__tests__/prompt-submit-hook.test.ts \
  packages/tim-cli/src/__tests__/claude-stop-hook.test.ts
```

Expected: all pass.

- [ ] **Step 4: Write verification evidence**

Record exact command outputs, test counts, marker hashes, generated MCP smoke result, and one mapping row per GitHub issue. Do not claim issue closure where acceptance evidence is missing.

- [ ] **Step 5: Final review and commit**

Request one cross-cutting specification review and one code-quality review over `1eccf19..HEAD`. Resolve every important finding, rerun Steps 1–3, then commit the report:

```bash
git add docs/superpowers/reports/2026-07-16-open-issues-verification.md
git commit -m "docs: record open issue remediation verification"
```
