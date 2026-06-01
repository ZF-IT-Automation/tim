# TIM Start-Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a fresh agent session, auto-detect the `.tim-project` marker in the workspace and inject a directive that makes the agent load the bound TIM project — across Hermes, Claude Code, and Cursor.

**Architecture:** A single store-free CLI command (`tim resolve-project`) walks up from the session cwd to the nearest `.tim-project`, parses it, and emits a ready-to-inject *directive*. Thin per-harness shell hooks call that command on session start and wrap the directive in each harness's hook-output envelope. The agent (which holds the MCP tools) does the actual `tim_load_project` call. A companion store-free writer (`tim bind-project`) plus the handoff skill close the marker-creation loop.

**Tech Stack:** TypeScript (Node 24, ESM, monorepo workspaces), Vitest, Bash + `jq` for the hook wrappers. Build: `tsc -b`. The marker walk-up + parse lives in Node (cross-platform); shell wrappers stay thin.

---

## Corrections to the original PLAN (read before starting)

The original PLAN described the **Claude Code** hook model. Verified against the live Hermes source (`~/.hermes/hermes-agent/`), four premises are wrong and the plan below supersedes them:

1. **Hermes has no `on_session_start` event with a `startup|clear|compact` matcher.** Hermes fires `pre_llm_call` **once per turn** (`agent/conversation_loop.py:535`). Session-start work is gated on `is_first_turn`. (The `startup|clear|compact` matcher *is* real — but only for **Claude Code** `SessionStart`, Task 5.)
2. **Hermes injects hook context into the user message, not the system prompt** (`conversation_loop.py:540-544`, to preserve the prompt-cache prefix). Functionally fine for our directive; don't claim "system prompt."
3. **Hermes hook scripts live in `~/.hermes/agent-hooks/`** (symlinks into the hmem repo), not `~/.hermes/hooks/` (which is empty). Registration is `config.yaml` → `hooks.pre_llm_call`, not a `SessionStart` matcher block.
4. **The Hermes payload already carries `.cwd`** (top-level) and event kwargs under `.extra` (`agent/shell_hooks.py:474-482`; `conversation_loop.py:550-559`). No cwd-probe needed for Hermes. Fields available first turn: top-level `.cwd`, `.session_id`; under `.extra`: `.is_first_turn`, `.platform`, `.model`, `.sender_id`, `.user_message`.

**Verified-good facts the plan relies on:**

- **Hermes merges multiple `pre_llm_call` outputs.** It collects every hook's `{context}` and joins with `\n\n` (`conversation_loop.py:560-567`). So a **standalone** second hook is fully supported — we do **not** patch the hmem-repo `o9k-startup.sh`.
- **Per-hook output contract** (`agent/shell_hooks.py:496-539`): `pre_llm_call` → `{"context":"…"}` passed through; empty/`{}`/non-JSON → ignored. Non-zero exit is logged but stdout still parsed.
- **MCP tool is `tim_load_project` with required `label`** (`packages/tim-mcp/src/server.ts:774-789`). Always use `tim_load_project(label="P00XX")` — never the legacy `id:` form.
- **`runSessionStart` already writes a full marker** and resolves project via `resolveSessionProjectId` (`packages/tim-hooks/src/checkpoint.ts:47-117`): explicit → `detectProject(cwd)` (single-dir) → `getActiveProjectLabel()` → Inbox `P0000`.

---

## Scope, end-state & the marker lifecycle (READ — load-bearing)

### What this feature is vs. is not
- **In scope:** the *read* path (resolve marker → inject directive → agent loads project) on all three harnesses, the marker *write* paths that feed it, and the two skill patches.
- **Out of scope:** changing the MCP server, changing the session/checkpoint pipeline, formatting the project brief inside the hook (the agent's in-session `tim_load_project` does that). The hook never opens the store.

### The marker-creation loop (do not assume markers pre-exist)
A read-only start hook is only half a loop: if nothing ever **writes** `.tim-project`, the hook reads a file that never exists. Markers are created by, in order of importance:

1. **Handoff (Task 8)** — on `/o9k-handoff`, refresh `.tim-project.project` to the active project in each touched repo, so the *next* session auto-binds. This is the primary durable path.
2. **`tim hook session-start`** (already implemented) — writes a complete marker when a session is explicitly bound (`checkpoint.ts:94-104`).
3. **`tim bind-project` (added in Task 3b)** — store-free one-shot writer for handoff / manual / project-creation use.
4. **Committed to the repo** — a project root may commit `.tim-project` with a stable `project` field (the `session`/`exchanges` fields are runtime noise; only `project` matters to the start hook).

### Base case (correct behavior, state it explicitly)
The **first-ever** session in a brand-new project legitimately has **no marker** → the hook resolves nothing → **silent skip** → the session falls through to the P0000 Inbox path. During that session, handoff/project-creation writes the marker, so every **subsequent** session auto-binds. This is intended, not a bug.

### Transitional end-state: TIM is authoritative over hmem
During migration, a Hermes first turn receives **two** concatenated directives: `o9k-startup.sh`'s ("run o9k-session-start, hmem context pre-injected") **and** the new TIM directive ("call `tim_load_project`"). These bind project from **two different stores**. **Decision: the TIM `.tim-project` marker directive is authoritative for project binding.** When both are present, the agent calls `tim_load_project(label=…)` and does **not** also run the hmem cwd→project resolution. This is encoded both in the directive text (Task 3) and in the skill patch (Task 7). End-state once TIM fully replaces hmem: `o9k-startup.sh`'s project-binding is retired and only the TIM directive remains.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/tim-hooks/src/marker.ts` | Modify | Add `findMarker` (walk-up) + `buildLoadDirective` (shared directive text). |
| `packages/tim-hooks/src/index.ts` | Modify | Re-export `findMarker`, `buildLoadDirective`, `MarkerLocation`. |
| `packages/tim-hooks/src/checkpoint.ts` | Modify | `resolveSessionProjectId` uses `findMarker` (walk-up) instead of single-dir `detectProject`. |
| `packages/tim-hooks/src/__tests__/marker.test.ts` | Modify | Tests for `findMarker` (nearest-wins, parent-find, root-termination, corrupt-nearest) + `buildLoadDirective`. |
| `packages/tim-cli/src/cli.ts` | Modify | Add `resolve-project` (read) + `bind-project` (write) subcommands; both store-free. |
| `packages/tim-cli/src/__tests__/resolve-project.test.ts` | Create | CLI-level tests for both subcommands. |
| `packages/tim-hooks/scripts/tim-session-start.sh` | Create | Hermes `pre_llm_call` wrapper. |
| `packages/tim-hooks/scripts/tim-claude-session-start.sh` | Create | Claude Code `SessionStart` wrapper. |
| `packages/tim-hooks/scripts/tim-cursor-inject.sh` | Create | Cursor best-effort launch-time injector. |
| `~/.hermes/config.yaml` | Modify | Add second `pre_llm_call` command. |
| `~/.claude/settings.json` | Modify | Add `SessionStart` matcher entry. |
| `~/.hermes/skills/o9k-session-start/SKILL.md` | Modify | STEP 1: TIM-marker-directive branch (authoritative). |
| `~/.hermes/skills/o9k/o9k-handoff/SKILL.md` | Modify | Step 2.5: refresh `.tim-project` for the active project. |

> Hook scripts live **in the TIM repo** (version-controlled) and are symlinked into `~/.hermes/agent-hooks/`, mirroring the existing `o9k-startup.sh` → `~/projects/hmem/hermes-hooks/` convention. The CLI path is overridable via `TIM_CLI`, defaulting to `/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js`.

---

## Task 1: `findMarker` walk-up + shared directive in `marker.ts`

**Files:**
- Modify: `packages/tim-hooks/src/marker.ts`
- Modify: `packages/tim-hooks/src/index.ts`
- Test: `packages/tim-hooks/src/__tests__/marker.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/tim-hooks/src/__tests__/marker.test.ts` inside the `describe('marker', …)` block (the file already imports `fs`, `path`, and creates `dir` via `mkdtempSync` under `TEST_ROOT` in `beforeEach`). Add `findMarker` and `buildLoadDirective` to the import from `'../marker.js'`:

```ts
  it('findMarker returns the marker in the cwd itself', () => {
    writeMarker(dir, { project: 'P1', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const found = findMarker(dir);
    expect(found?.marker.project).toBe('P1');
    expect(found?.dir).toBe(fs.realpathSync(dir));
  });

  it('findMarker walks up to a parent marker', () => {
    writeMarker(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'a', 'b', 'c');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub)?.marker.project).toBe('PARENT');
  });

  it('findMarker: nearest marker wins over an ancestor', () => {
    writeMarker(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    writeMarker(sub, { project: 'CHILD', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    expect(findMarker(sub)?.marker.project).toBe('CHILD');
  });

  it('findMarker returns null when no marker exists up to root (no infinite loop)', () => {
    const sub = path.join(dir, 'x', 'y');
    fs.mkdirSync(sub, { recursive: true });
    expect(findMarker(sub)).toBeNull();
  });

  it('findMarker stops at a corrupt nearest marker (does not silently use an ancestor)', () => {
    writeMarker(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    const sub = path.join(dir, 'child');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.tim-project'), '{ not valid json');
    expect(findMarker(sub)).toBeNull();
  });

  it('buildLoadDirective embeds the label and the load instruction', () => {
    const d = buildLoadDirective('P0063', '/home/bbbee/projects/tim');
    expect(d).toContain('P0063');
    expect(d).toContain('tim_load_project(label="P0063")');
    expect(d).toContain('.tim-project');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts`
Expected: FAIL — `findMarker`/`buildLoadDirective` are not exported (`SyntaxError` / `undefined is not a function`).

- [ ] **Step 3: Implement `findMarker` and `buildLoadDirective`**

Append to `packages/tim-hooks/src/marker.ts` (the file already imports `fs` and `path` and defines `markerPath`, `readMarker`, `ProjectMarker`):

```ts
export interface MarkerLocation {
  marker: ProjectMarker;
  dir: string;
}

/**
 * Walk up from `startCwd` to the filesystem root and return the NEAREST
 * `.tim-project` (closest ancestor wins). Pure FS — no store, no network —
 * so it is safe to call from a hook under a tight timeout.
 *
 * If the nearest marker FILE exists but is unparseable, we STOP and return
 * null rather than silently binding an ancestor's project.
 */
export function findMarker(startCwd: string): MarkerLocation | null {
  let dir = path.resolve(startCwd);
  for (let i = 0; i < 256; i++) {
    if (fs.existsSync(markerPath(dir))) {
      const marker = readMarker(dir); // null when corrupt
      return marker ? { marker, dir } : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Shared, harness-agnostic directive text. Every start hook (Hermes,
 * Claude Code, Cursor) emits exactly this so wording stays DRY. The TIM
 * marker is authoritative for project binding this turn (see plan §end-state).
 */
export function buildLoadDirective(label: string, markerDir: string): string {
  return [
    `📍 TIM project marker detected (.tim-project in ${markerDir}).`,
    `This session is bound to TIM project ${label}.`,
    ``,
    `ACTION: call tim_load_project(label="${label}") now to load the project ` +
      `brief from the TIM store, then run the o9k-session-start skill. STEP 1 ` +
      `(project binding) is already decided by this marker — do NOT ask which ` +
      `project, and do NOT run any hmem/active-project cwd→project resolution. ` +
      `The TIM marker is authoritative for this turn.`,
  ].join('\n');
}
```

- [ ] **Step 4: Re-export from `index.ts`**

In `packages/tim-hooks/src/index.ts`, extend the `./marker.js` export block to add `findMarker`, `buildLoadDirective`, and `type MarkerLocation`:

```ts
export {
  readMarker,
  writeMarker,
  detectProject,
  findMarker,
  buildLoadDirective,
  reconcileMarker,
  acquireLock,
  releaseLock,
  markerPath,
  MARKER_FILENAME,
  MARKER_LOCK,
  LOCK_TTL_MS,
  type ProjectMarker,
  type MarkerLocation,
  type SummarizerConfig,
} from './marker.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts`
Expected: PASS (all marker tests, including the new six).

- [ ] **Step 6: Commit**

```bash
cd /home/bbbee/projects/tim
git add packages/tim-hooks/src/marker.ts packages/tim-hooks/src/index.ts packages/tim-hooks/src/__tests__/marker.test.ts
git commit -m "feat(tim-hooks): findMarker walk-up + shared load directive"
```

---

## Task 2: `resolveSessionProjectId` uses `findMarker` (DRY walk-up)

**Files:**
- Modify: `packages/tim-hooks/src/checkpoint.ts:47-59`
- Test: `packages/tim-hooks/src/__tests__/hooks.test.ts`

Rationale: session-binding (`runSessionStart`) currently resolves the marker only in the exact cwd (`detectProject`). A session started in a project **subdirectory** should still bind the project. Switch resolution to the walk-up. The marker *write* in `runSessionStart` stays at `params.cwd` (unchanged behavior; a subdir session writing its own marker is acceptable and `findMarker`'s nearest-wins keeps resolution correct).

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` in `packages/tim-hooks/src/__tests__/hooks.test.ts` (it already imports `runSessionStart`, `TimStore`, `fs`, `path` and builds temp dirs — mirror the existing setup there):

```ts
  it('runSessionStart resolves a parent .tim-project from a subdirectory', async () => {
    const store = new TimStore(':memory:');
    await store.createProject('P0042');
    const root = fs.mkdtempSync(path.join('/home/bbbee', '.tim-test-runs', 'sess-'));
    fs.writeFileSync(
      path.join(root, '.tim-project'),
      JSON.stringify({ project: 'P0042', session: 'old', exchanges: 0, batch_size: 5, batches_summarized: 0 }),
    );
    const sub = path.join(root, 'pkg', 'inner');
    fs.mkdirSync(sub, { recursive: true });

    const { project } = await runSessionStart(store, {
      sessionId: 'sess-sub',
      agentName: 'a',
      cwd: sub,
      harness: 'test',
    });

    expect(project?.metadata.label ?? project?.id).toBe('P0042');
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-hooks/src/__tests__/hooks.test.ts`
Expected: FAIL — resolves to Inbox `P0000` (single-dir `detectProject` misses the parent marker), so `project.label !== 'P0042'`.

- [ ] **Step 3: Switch resolution to `findMarker`**

In `packages/tim-hooks/src/checkpoint.ts`, update the import on line 14 and `resolveSessionProjectId` (lines 47-59):

```ts
import { detectProject, findMarker, writeMarker } from './marker.js';
```

```ts
async function resolveSessionProjectId(
  store: TimStore,
  cwd: string,
  explicitProjectId?: string,
): Promise<string> {
  if (explicitProjectId) return explicitProjectId;
  const located = findMarker(cwd);
  if (located) return located.marker.project;
  const active = getActiveProjectLabel();
  if (active) return active;
  await ensureInboxProject(store);
  return INBOX_PROJECT_LABEL;
}
```

> `detectProject` stays imported only if still referenced elsewhere; if TypeScript flags it unused (`tsc --noEmit`), drop it from the import. Verify in Step 5.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-hooks/src/__tests__/hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + full hooks suite**

Run: `cd /home/bbbee/projects/tim && npm run lint && npx vitest run packages/tim-hooks`
Expected: no TS errors (fix the `detectProject` unused import if flagged); all tim-hooks tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/bbbee/projects/tim
git add packages/tim-hooks/src/checkpoint.ts packages/tim-hooks/src/__tests__/hooks.test.ts
git commit -m "feat(tim-hooks): session-start resolves marker via walk-up"
```

---

## Task 3: `tim resolve-project` (read) + `tim bind-project` (write) — store-free

**Files:**
- Modify: `packages/tim-cli/src/cli.ts`
- Test: `packages/tim-cli/src/__tests__/resolve-project.test.ts` (Create)

Both subcommands are **store-free** (no `loadConfig`/`new TimStore`) — pure FS so they stay well under the 10s hook timeout and can never block on a DB lock. Label validation happens in-session via `tim_load_project`.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-cli/src/__tests__/resolve-project.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = path.join('/home/bbbee', '.tim-test-runs');

function run(args: string[]): string {
  try {
    return execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

describe('tim resolve-project / bind-project', () => {
  let dir: string;
  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'cli-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resolve-project prints the label (default format)', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ project: 'P0063', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
    expect(run(['resolve-project', '--cwd', dir]).trim()).toBe('P0063');
  });

  it('resolve-project prints nothing and exits 0 when no marker', () => {
    expect(run(['resolve-project', '--cwd', dir]).trim()).toBe('');
  });

  it('resolve-project --format directive contains the load instruction', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ project: 'P0063', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive']);
    expect(out).toContain('tim_load_project(label="P0063")');
  });

  it('bind-project writes a marker; resolve-project reads it back', () => {
    run(['bind-project', '--cwd', dir, '--label', 'P0099']);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker.project).toBe('P0099');
    expect(run(['resolve-project', '--cwd', dir]).trim()).toBe('P0099');
  });

  it('bind-project preserves existing counters, only changes project', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ project: 'OLD', session: 's7', exchanges: 12, batch_size: 3, batches_summarized: 4 }));
    run(['bind-project', '--cwd', dir, '--label', 'P0100']);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker).toMatchObject({ project: 'P0100', session: 's7', exchanges: 12, batch_size: 3, batches_summarized: 4 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/bbbee/projects/tim && npm run build && npx vitest run packages/tim-cli/src/__tests__/resolve-project.test.ts`
Expected: FAIL — `Unknown command: resolve-project` / `bind-project` printed by the CLI.

- [ ] **Step 3: Add imports**

In `packages/tim-cli/src/cli.ts`, extend the `tim-hooks` import on line 6:

```ts
import {
  runCheckpoint,
  runSessionEnd,
  runSessionStart,
  findMarker,
  buildLoadDirective,
  readMarker,
  writeMarker,
  type ProjectMarker,
} from 'tim-hooks';
```

- [ ] **Step 4: Add the two command handlers**

Add these functions to `packages/tim-cli/src/cli.ts` (near `cmdStats`; note neither opens a store):

```ts
async function cmdResolveProject(args: string[]) {
  const flags = parseArgs(args);
  const cwd = flags.cwd ?? process.cwd();
  const format = flags.format ?? 'label';

  const located = findMarker(cwd);
  if (!located) return; // no marker (or corrupt nearest) → silent skip, exit 0

  const { marker, dir } = located;
  if (format === 'json') {
    console.log(JSON.stringify({ ...marker, dir }));
  } else if (format === 'directive') {
    process.stdout.write(buildLoadDirective(marker.project, dir));
  } else {
    process.stdout.write(marker.project);
  }
}

async function cmdBindProject(args: string[]) {
  const flags = parseArgs(args);
  const cwd = flags.cwd ?? process.cwd();
  const label = flags.label;
  if (!label) {
    console.error('Usage: tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]');
    process.exit(1);
  }
  const existing = readMarker(cwd);
  const marker: ProjectMarker = {
    project: label,
    session: flags.session ?? existing?.session ?? '',
    exchanges: existing?.exchanges ?? 0,
    batch_size: existing?.batch_size ?? 5,
    batches_summarized: existing?.batches_summarized ?? 0,
    summarizer: existing?.summarizer,
  };
  writeMarker(cwd, marker);
  console.log(`Wrote .tim-project → ${label} at ${cwd}`);
}
```

- [ ] **Step 5: Wire into the command switch + help**

In `main()` (`cli.ts`), add cases before `default:`:

```ts
    case 'resolve-project':
      await cmdResolveProject(rest);
      break;
    case 'bind-project':
      await cmdBindProject(rest);
      break;
```

In the `--help` text, add under Commands:

```
  resolve-project       Print bound project from nearest .tim-project (--cwd, --format label|json|directive)
  bind-project          Write/refresh .tim-project for a project (--label, --cwd, --session)
```

- [ ] **Step 6: Build + run the tests to verify they pass**

Run: `cd /home/bbbee/projects/tim && npm run build && npx vitest run packages/tim-cli/src/__tests__/resolve-project.test.ts`
Expected: PASS (all 5).

- [ ] **Step 7: Smoke-test the built CLI manually**

```bash
cd /home/bbbee/projects/tim
TMP=$(mktemp -d)
printf '{"project":"P0063","session":"s","exchanges":0,"batch_size":5,"batches_summarized":0}' > "$TMP/.tim-project"
node packages/tim-cli/dist/cli.js resolve-project --cwd "$TMP"                 # → P0063
echo "---"
node packages/tim-cli/dist/cli.js resolve-project --cwd "$TMP" --format directive  # → directive text
echo "---"
node packages/tim-cli/dist/cli.js resolve-project --cwd /tmp; echo "exit=$?"   # → (empty) exit=0
rm -rf "$TMP"
```
Expected: `P0063`, then the directive, then empty output with `exit=0`.

- [ ] **Step 8: Commit**

```bash
cd /home/bbbee/projects/tim
git add packages/tim-cli/src/cli.ts packages/tim-cli/src/__tests__/resolve-project.test.ts
git commit -m "feat(tim-cli): store-free resolve-project + bind-project commands"
```

---

## Task 4: Hermes `pre_llm_call` hook

**Files:**
- Create: `packages/tim-hooks/scripts/tim-session-start.sh`
- Modify: `~/.hermes/config.yaml` (`hooks.pre_llm_call`)
- Symlink: `~/.hermes/agent-hooks/tim-session-start.sh`

- [ ] **Step 1: Write the hook script**

Create `packages/tim-hooks/scripts/tim-session-start.sh`:

```bash
#!/usr/bin/env bash
# tim-session-start.sh — Hermes pre_llm_call hook (TIM project auto-load).
#
# pre_llm_call fires every turn; we act ONLY on the first turn of a session.
# Reads the session cwd from the payload, resolves the nearest .tim-project
# (walk-up, in Node), and injects a load directive.
#
# Output contract (Hermes pre_llm_call): {"context":"..."} → appended to the
# user message. Empty/`{}` → ignored. Hermes concatenates this with
# o9k-startup.sh's context (\n\n). See plan §Corrections.
#
# Requires: jq, node. Override the CLI path with TIM_CLI.
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

payload="$(cat -)"

is_first=$(printf '%s' "$payload" | jq -r '.extra.is_first_turn // false')
# Subagent guard: .parentUuid is a Claude-Code field (no-op on Hermes today —
# see plan §Subagent probe). parent_session_id covers any future Hermes signal.
parent=$(printf '%s' "$payload" | jq -r '.extra.parentUuid // .parent_session_id // empty')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')

if [[ -n "$parent" ]]; then printf '{}\n'; exit 0; fi
if [[ "$is_first" != "true" ]]; then printf '{}\n'; exit 0; fi
if [[ -z "$cwd" ]]; then printf '{}\n'; exit 0; fi

directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)

# No marker (or corrupt nearest) → silent skip, normal session start.
if [[ -z "$directive" ]]; then printf '{}\n'; exit 0; fi

jq -n --arg ctx "$directive" '{context: $ctx}'
exit 0
```

- [ ] **Step 2: Make executable + symlink into agent-hooks**

```bash
chmod +x /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-session-start.sh
ln -sfn /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-session-start.sh \
  /home/bbbee/.hermes/agent-hooks/tim-session-start.sh
ls -l /home/bbbee/.hermes/agent-hooks/tim-session-start.sh
```
Expected: symlink resolves to the repo script.

- [ ] **Step 3: Unit-test the script with a synthetic payload (no Hermes needed)**

```bash
# Marker present, first turn → directive
TMP=$(mktemp -d)
printf '{"project":"P0063","session":"s","exchanges":0,"batch_size":5,"batches_summarized":0}' > "$TMP/.tim-project"
printf '{"cwd":"%s","session_id":"t","extra":{"is_first_turn":true,"platform":"cli"}}' "$TMP" \
  | bash /home/bbbee/.hermes/agent-hooks/tim-session-start.sh
echo "--- not first turn → {} ---"
printf '{"cwd":"%s","extra":{"is_first_turn":false}}' "$TMP" \
  | bash /home/bbbee/.hermes/agent-hooks/tim-session-start.sh
echo "--- no marker → {} ---"
printf '{"cwd":"/tmp","extra":{"is_first_turn":true}}' \
  | bash /home/bbbee/.hermes/agent-hooks/tim-session-start.sh
rm -rf "$TMP"
```
Expected: (1) `{"context":"📍 TIM project marker…tim_load_project(label=\"P0063\")…"}`; (2) `{}`; (3) `{}`.

- [ ] **Step 4: Register in `~/.hermes/config.yaml`**

Edit the `hooks.pre_llm_call` list (currently lines 432-434) to add a second command **after** `o9k-startup.sh`:

```yaml
hooks:
  pre_llm_call:
  - command: ~/.hermes/agent-hooks/o9k-startup.sh
    timeout: 10
  - command: ~/.hermes/agent-hooks/tim-session-start.sh
    timeout: 10
  post_llm_call:
  - command: ~/.hermes/agent-hooks/o9k-log-exchange.sh
    timeout: 10
  on_session_end:
  - command: /bin/bash -c 'exec node /home/bbbee/projects/tim/packages/tim-cli/dist/cli.js checkpoint --session "$HERMES_SESSION_KEY"'
    timeout: 120
hooks_auto_accept: true
```

> Back up first: `cp ~/.hermes/config.yaml ~/.hermes/config.yaml.bak.$(date +%Y%m%d_%H%M%S)`. `hooks_auto_accept: true` is already set; if Hermes still gates the new command via `~/.hermes/shell-hooks-allowlist.json`, approve it in Step 5.

- [ ] **Step 5: Validate via the Hermes hook test harness + allowlist**

```bash
hermes hooks doctor                 # lists registered hooks; new command should appear/validate
hermes hooks test pre_llm_call      # feeds a synthetic payload through both pre_llm_call hooks
```
Expected: the harness runs `tim-session-start.sh` without error. If it reports the command is not allowlisted, approve it (e.g. `hermes hooks doctor --accept-hooks`, or `HERMES_ACCEPT_HOOKS=1`, or add an `{event:"pre_llm_call", command:"~/.hermes/agent-hooks/tim-session-start.sh"}` entry to `~/.hermes/shell-hooks-allowlist.json` per its existing schema). Re-run `hermes hooks doctor` to confirm.

- [ ] **Step 6: Commit the repo-tracked script**

```bash
cd /home/bbbee/projects/tim
git add packages/tim-hooks/scripts/tim-session-start.sh
git commit -m "feat(tim-hooks): Hermes pre_llm_call session-start hook"
```
> `~/.hermes/config.yaml`, the symlink, and the allowlist are machine state, not repo files — record the exact edits in the project's Next Steps / handoff so another machine can reproduce them.

---

## Task 5: Claude Code `SessionStart` hook

**Files:**
- Create: `packages/tim-hooks/scripts/tim-claude-session-start.sh`
- Modify: `~/.claude/settings.json` (`SessionStart`)

Claude Code's `SessionStart` payload includes `.cwd` and `.source` (`startup|resume|clear|compact`). Output contract: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` (mirrors the existing `~/.claude/hooks/hmem-session-inject.sh`).

- [ ] **Step 1: Write the hook script**

Create `packages/tim-hooks/scripts/tim-claude-session-start.sh`:

```bash
#!/usr/bin/env bash
# tim-claude-session-start.sh — Claude Code SessionStart hook (TIM project auto-load).
# Reads cwd from the SessionStart payload, resolves nearest .tim-project (walk-up),
# emits additionalContext directive. Requires: jq, node. Override path with TIM_CLI.
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

payload="$(cat -)"
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
[[ -z "$cwd" ]] && exit 0

directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)
[[ -z "$directive" ]] && exit 0

jq -n --arg ctx "$directive" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
```

- [ ] **Step 2: Make executable + unit-test**

```bash
chmod +x /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-claude-session-start.sh
TMP=$(mktemp -d)
printf '{"project":"P0063","session":"s","exchanges":0,"batch_size":5,"batches_summarized":0}' > "$TMP/.tim-project"
printf '{"cwd":"%s","session_id":"t","source":"startup"}' "$TMP" \
  | bash /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-claude-session-start.sh
printf '{"cwd":"/tmp","source":"startup"}' \
  | bash /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-claude-session-start.sh; echo "exit=$?"
rm -rf "$TMP"
```
Expected: (1) `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"📍 TIM…"}}`; (2) no output, `exit=0`.

- [ ] **Step 3: Register in `~/.claude/settings.json`**

Back up: `cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d_%H%M%S)`. Add a new object to the existing `SessionStart` array (alongside the hmem entries):

```json
{
  "matcher": "startup|clear|compact",
  "hooks": [
    {
      "type": "command",
      "command": "bash /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-claude-session-start.sh",
      "timeout": 10
    }
  ]
}
```

Validate JSON: `node -e "JSON.parse(require('fs').readFileSync('/home/bbbee/.claude/settings.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Live check**

In a Claude Code session started inside a directory containing a `.tim-project` (e.g. this repo with a temp marker), run `/hooks` to confirm the SessionStart hook is registered, then start a fresh session and confirm the injected `📍 TIM project marker` context appears. (Claude Code provides `cwd` to SessionStart, so the walk-up works natively.)

- [ ] **Step 5: Commit**

```bash
cd /home/bbbee/projects/tim
git add packages/tim-hooks/scripts/tim-claude-session-start.sh
git commit -m "feat(tim-hooks): Claude Code SessionStart hook"
```

---

## Task 6: Cursor CLI injection (best-effort — verify mechanism first)

**Files:**
- Create: `packages/tim-hooks/scripts/tim-cursor-inject.sh`

Cursor's `agent` / `cursor-agent` CLI has **no SessionStart hook**. This task is **best-effort** — verify the mechanism before relying on it, and do not block the other harnesses on it.

- [ ] **Step 1: Probe what cursor-agent supports**

```bash
cursor-agent --help 2>&1 | grep -iE 'rule|instruct|system|prompt|context|append' || echo "no obvious flag"
ls -la .cursor/rules 2>/dev/null || echo "no .cursor/rules in cwd"
```
Record the result. Two viable paths depending on output:
- **(A) Rules-file path:** cursor-agent auto-loads `.cursor/rules/*.mdc` / `AGENTS.md` from the project. Then `tim bind-project` (Task 3b) can additionally drop a `.cursor/rules/tim.mdc` containing the directive (label is fixed per project, so static text is fine).
- **(B) Launch-time path (default, matches CLAUDE.md's send-keys workflow):** the orchestrator resolves the directive and prepends it to the first prompt when launching Cursor via tmux.

- [ ] **Step 2: Write the launch-time injector (path B — always works)**

Create `packages/tim-hooks/scripts/tim-cursor-inject.sh`:

```bash
#!/usr/bin/env bash
# tim-cursor-inject.sh — print the TIM load directive for a workspace, for the
# orchestrator to prepend to Cursor's first prompt (Cursor has no SessionStart hook).
# Usage: tim-cursor-inject.sh <project-dir>
set -euo pipefail
TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"
cwd="${1:-$PWD}"
node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true
```

```bash
chmod +x /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-cursor-inject.sh
```

Orchestrator usage (documented, not automated here):
```bash
DIR=/home/bbbee/projects/tim
DIRECTIVE=$(bash /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-cursor-inject.sh "$DIR")
# send "$DIRECTIVE"$'\n\n'"$REAL_TASK" to the cursor pane via tmux send-keys
```

- [ ] **Step 3: Verify + commit**

```bash
bash /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-cursor-inject.sh /home/bbbee/projects/tim
cd /home/bbbee/projects/tim
git add packages/tim-hooks/scripts/tim-cursor-inject.sh
git commit -m "feat(tim-hooks): Cursor best-effort directive injector"
```
> If the probe (Step 1) shows a reliable rules-file mechanism, extend `cmdBindProject` to also write `.cursor/rules/tim.mdc` in a follow-up — out of scope for v1.

---

## Task 7: Patch `o9k-session-start` SKILL.md — TIM marker directive branch

**Files:**
- Modify: `~/.hermes/skills/o9k-session-start/SKILL.md` (STEP 1, lines 23-31)

Resolves the contradiction: the skill currently says "brief present → do NOT call `tim_load_project`," but the TIM directive instructs the agent **to** call it. Add an explicit, authoritative branch.

- [ ] **Step 1: Insert the TIM-marker branch into STEP 1**

In `## STEP 1`, add this as the **first** case bullet (before "Brief present, right project"):

```markdown
- **`📍 TIM project marker` directive present** (a `.tim-project` bound this workspace; injected by the TIM start hook) → the marker is **authoritative**. Call `tim_load_project(label="P00XX")` **exactly once** with the label from the directive — this is the one allowed load (it is *not* the "brief already injected" case). Then continue from STEP 2. Do **not** ask which project, and do **not** also run the hmem/`active-project` cwd→project resolution, even if an hmem directive is present in the same turn. If a *different* project's marker label conflicts with what the user names in their first message, prefer the user's explicit request and switch via `o9k-tim_session_start`.
```

- [ ] **Step 2: Verify the skill still loads**

```bash
sed -n '1,5p' /home/bbbee/.hermes/skills/o9k-session-start/SKILL.md   # frontmatter intact
grep -n '📍 TIM project marker' /home/bbbee/.hermes/skills/o9k-session-start/SKILL.md
```
Expected: frontmatter unchanged; the new bullet present.

- [ ] **Step 3: Commit (if the skills dir is a repo) or record in handoff**

The skills live under `~/.hermes/skills/` (machine state). If it is git-tracked there, commit; otherwise note the exact edit in the project's Next Steps so it propagates. The canonical skill source may also live in the `hmem`/`o9k` repo — if so, apply the same patch there and re-sync.

---

## Task 8: Patch `o9k-handoff` SKILL.md — refresh the marker (closes the creation loop)

**Files:**
- Modify: `~/.hermes/skills/o9k/o9k-handoff/SKILL.md`

This is the **primary durable marker-creation path** (see plan §marker lifecycle). On handoff, ensure each touched repo's `.tim-project` points at the active project so the next session auto-binds.

- [ ] **Step 1: Insert Step 2.5 after "Step 2: Update Next Steps"**

```markdown
## Step 2.5: Refresh the .tim-project marker (so the next session auto-loads)

The TIM start hook reads `.tim-project` to auto-load the project on a fresh
session. Before clearing, make sure it points at the active project:

1. For the active project `P00XX` and the repo root you worked in (`<repo>`):
   ```bash
   cat <repo>/.tim-project 2>/dev/null   # check the current "project" field
   ```
2. If it is missing or names a different project, refresh it (store-free, only
   the `project` field changes; existing counters are preserved):
   ```bash
   node /home/bbbee/projects/tim/packages/tim-cli/dist/cli.js \
     bind-project --cwd <repo> --label P00XX
   ```
3. Only the `project` field matters to the start hook — leave `session`/`exchanges`
   to the session/checkpoint pipeline.

Skip this for sessions bound to the **P0000 Inbox** (no real project to pin).
```

- [ ] **Step 2: Verify**

```bash
grep -n 'Step 2.5\|bind-project' /home/bbbee/.hermes/skills/o9k/o9k-handoff/SKILL.md
```
Expected: the new section and the `bind-project` command are present.

- [ ] **Step 3: Commit / record** (same note as Task 7 Step 3).

---

## Subagent probe (Hermes) — resolve before declaring Task 4 complete

The `.parentUuid` guard in Task 4 is a **Claude-Code** field; Hermes `pre_llm_call` passes **no** parent indicator (`conversation_loop.py:550-559`). So on Hermes the guard is currently a no-op. Determine whether it matters:

- [ ] **Probe:** does a Hermes-dispatched subagent fire `pre_llm_call` with `is_first_turn=true`?
  - Inspect: `grep -rn "pre_llm_call\|is_first_turn\|subagent" ~/.hermes/hermes-agent/agent/conversation_loop.py` and check whether dispatched subagents route through the same `run_conversation` path.
  - Or empirically: dispatch a subagent from a Hermes session whose cwd has a `.tim-project`, and check whether the subagent received the `📍 TIM project marker` directive (e.g. via `~/.hermes/logs/` or by having the subagent echo its injected context).
- [ ] **If subagents do NOT fire `is_first_turn=true`:** no action — the `is_first_turn` gate already suppresses them. Note this in the project log.
- [ ] **If they DO and expose a distinguishing field** (e.g. `.extra.sender_id`, a subagent-shaped `.session_id`, or a parent id): tighten the guard in `tim-session-start.sh` to skip on that field.
- [ ] **If they DO and expose no signal:** document that "Hermes subagent suppression is unsolved." Impact is **low** — a subagent would make one extra `tim_load_project` call (wasteful, not harmful). Revisit if Hermes adds a parent id to `pre_llm_call` kwargs.

---

## End-to-end manual test (after all tasks)

- [ ] **1. Build everything**
```bash
cd /home/bbbee/projects/tim && npm run build && npm test
```
Expected: build clean; full suite green (existing 88 + new tests).

- [ ] **2. Create a marker in this repo**
```bash
node /home/bbbee/projects/tim/packages/tim-cli/dist/cli.js bind-project --cwd /home/bbbee/projects/tim --label P0063
cat /home/bbbee/projects/tim/.tim-project
```
Expected: marker with `"project":"P0063"`.

- [ ] **3. Hermes:** start a fresh Hermes session whose cwd is `/home/bbbee/projects/tim`. Confirm the first turn's context contains `📍 TIM project marker … tim_load_project(label="P0063")` **and** that the agent calls `tim_load_project(label="P0063")` exactly once (not twice, not the hmem flow).

- [ ] **4. Claude Code:** start a fresh Claude Code session in `/home/bbbee/projects/tim`; confirm the SessionStart additionalContext carries the directive and the agent loads P0063.

- [ ] **5. Subdirectory (walk-up):** `cd packages/tim-hooks && <start a session>` → still resolves P0063 from the parent marker.

- [ ] **6. Negative / base case:** start a session in `/tmp` (no marker) → no directive injected, normal session start, falls through to Inbox. Corrupt the marker (`echo 'x' > .tim-project`) → no directive, no crash. Restore afterward.

- [ ] **7. Cleanup the test marker** if it should not be committed: `rm /home/bbbee/projects/tim/.tim-project` (or commit it intentionally if P0063 owns this repo).

---

## Self-review (completed against the original PLAN)

- **Task A (Hermes hook script):** ✅ Task 4 — but corrected to `pre_llm_call` + `is_first_turn` gate (Hermes has no `on_session_start`), `agent-hooks/` location, `.cwd` from payload, walk-up in Node.
- **Task B (registration):** ✅ Task 4 Steps 4-5 — `config.yaml hooks.pre_llm_call` second command + allowlist; context lands in the **user message** (corrected from "system prompt").
- **Task C (cross-CLI):** ✅ Hermes (Task 4), Claude Code (Task 5, native `SessionStart`+`.cwd`), Cursor (Task 6, best-effort with probe).
- **Task D (load_project integration):** ✅ directive instructs `tim_load_project(label="P00XX")`; skill patch (Task 7) makes the marker authoritative and prevents double-binding.
- **Edge cases:** No marker → silent skip (resolve-project exits 0 empty; hooks emit `{}`). Corrupt marker → `findMarker` returns null at that dir → skip (Task 1 test + Task 3 test). Multiple markers → nearest wins (Task 1 test). P0000 Inbox → base case, hook simply finds no marker. Subagent → `is_first_turn` gate + probe (Hermes guard caveat documented).
- **Marker creation (was missing from original PLAN):** ✅ lifecycle section + `tim bind-project` + handoff Task 8 close the loop; base case stated.
- **Type/name consistency:** `findMarker`/`MarkerLocation`/`buildLoadDirective`/`ProjectMarker` used identically across Tasks 1-3; directive uses `tim_load_project(label="…")` everywhere (never the legacy `id:` form).
