# TIM CLI Reference

TIM (Theoretically Infinite Memory) — a CLI tool for managing persistent AI agent memory
over SQLite. Built on an edge-and-tree knowledge model with FTS5 search, session tracking,
and o9k-sync distributed sync.

Workspace snapshot: 2026-07-09
Default DB: `~/.tim/tim.db` unless `TIM_DB_PATH` is set.

---

## Quick Start

```bash
# Check everything works
cd ~/projects/tim
node packages/tim-cli/dist/cli.js doctor

# See what project is bound to the current directory
node packages/tim-cli/dist/cli.js resolve-project --cwd .

# See status
node packages/tim-cli/dist/cli.js statusline
```

> **Alias:** If `tim` is on PATH (npm global install or symlink), just use `tim <cmd>`.
> Otherwise: `node /path/to/tim/packages/tim-cli/dist/cli.js <cmd>`.
> For this reference, all commands assume `tim` is on PATH.

---

## Command Overview (33 commands)

### Top-Level Summary

| # | Command | Description |
|---|---------|-------------|
| 1 | `tim init` | Initialize TIM — create DB, register agents, write MCP config |
| 2 | `tim doctor` | Run diagnostics — health check, broken links, orphans, top tags |
| 3 | `tim stats` | Show memory statistics — counts, depth distribution, top tags |
| 4 | `tim resolve-project` | Print bound project from nearest `.tim-project` marker |
| 5 | `tim resolve-session` | Print project_ref for a TIM session |
| 6 | `tim bind-project` | Safely recover a missing `.tim-project` for an existing project |
| 7 | `tim new-project` | Create a path-bound project with coordinated label allocation and marker publication |
| 8 | `tim record-commit` | Record a git commit to the project's Commits section |
| 9 | `tim hook session-start` | Start a new session |
| 10 | `tim hook session-end` | End a session and run checkpoint |
| 11 | `tim hook log` | Log a single exchange to a session |
| 12 | `tim checkpoint` | Manual checkpoint for a session |
| 13 | `tim rebalance` | Rebalance exchange batches at boundaries |
| 14 | `tim statusline` | Status text or Hermes JSON for UI display |
| 15 | `tim setup-hermes-statusline` | Install Hermes TUI status bar integration |
| 16 | `tim export` | Export TIM DB to `.hmem` or text format |
| 17 | `tim import` | Import from `.hmem` file |
| 18 | `tim migrate-from-hmem` | Guided hmem-to-TIM migration with dry-run, snapshot, import, audit handoff |
| 19 | `tim migrate tags-to-types` | Convert legacy `#rule` / `#human` tags to `metadata.type` |
| 20 | `tim snapshot` | Snapshot live DB to `/tmp/tim-snapshots/` (SQLite backup) |
| 21 | `tim restore` | Restore DB from a snapshot |
| 22 | `tim release-check` | Verify release gates, beta smoke checks, and packaging safety |
| 23 | `tim setup-agent` | Install TIM MCP, skills, hooks, and smoke guidance for one agent host |
| 24 | `tim sync connect` | Connect to o9k-sync server |
| 25 | `tim sync disconnect` | Remove local sync configuration |
| 26 | `tim sync push` | Push unacked staging to server |
| 27 | `tim sync pull` | Pull remote changes |
| 28 | `tim sync status` | Show sync configuration and health |
| 29 | `tim sync dev` | Start local dev sync server (port 3100) |
| 30 | `tim user init` | Create the human profile scaffold |
| 31 | `tim user profile` | Show the human profile tree summary |
| 32 | `tim update-skills` | Copy bundled TIM skills to detected agent hosts |
| 33 | `tim --help` | Show top-level help |

---

## Detailed Command Reference

### 1. `tim init`

Initialize TIM (create DB, create tables, register agents, write MCP config).
**Idempotent-safe** — if DB exists, it validates health instead of re-creating.

```
✓ Database created: /home/bbbee/.tim/tim.db
✓ MCP config written: /home/bbbee/.tim/mcp.json
✓ Health: 2750 entries, FTS5=OK

TIM ready. Connect your MCP client to /home/bbbee/.tim/mcp.json
```

**Note:** `tim init --help` prints usage and exits before any DB work.

**MCP config written to `~/.tim/mcp.json`:**
```json
{
  "mcpServers": {
    "tim": {
      "command": "npx",
      "args": ["tim-mcp"],
      "env": { "TIM_DB_PATH": "/home/bbbee/.tim/tim.db" }
    }
  }
}
```

**TIP:** Symlink or copy `~/.tim/mcp.json` into your MCP client config (Claude Code, Cursor, etc.)
to enable the TIM MCP tools (tim_read, tim_search, tim_write, tim_update, etc.).

---

### 2. `tim doctor`

Run diagnostics. Shows DB health, entry/edge counts, broken links, orphan entries,
top tags, and whether Hermes statusline integration is installed.

**Full output** (`samples/tim-doctor.txt`):
```
═══ TIM Doctor ═══
DB: /home/bbbee/.tim/tim.db
Entries: 2750 | Edges: 10451
Confidence avg: 1.00
Broken links: 2
Orphan entries: 7201
FTS5: ✓
Agents: default
Oldest: 2026-05-25T10:16:17.080Z
Newest: 2026-06-17T07:54:40.556Z
Stale (>30d): 0

⚠ Issues:
  - 2 broken links
  - 7201 orphan entries

Top tags: #exchange(1258), #session-summary(448), #batch-summary(258), #session(189), #exchanges(186)
```

**What to watch for:**
- **Orphan entries** — entries with no parent edge. These accumulate during session checkpointing
  and are normal but indicate cleanup may help.
- **Broken links** — edges pointing to nonexistent entries. Should be fixed.
- **Stale count** — entries older than 30 days. High count means old memory isn't being pruned.

**Note:** `tim doctor --help` prints usage and exits before any DB work.

---

### 3. `tim stats`

JSON statistics about the database. Use with `jq` for filtering.

**Full output** (`samples/tim-stats.txt`):
```json
{
  "totalEntries": 2750,
  "totalEdges": 10451,
  "entriesByDepth": { "1": 15, "2": 62, "3": 505, "4": 378, "5": 1790 },
  "entriesByType": { "text": 2750 },
  "topTags": [
    { "tag": "#exchange", "count": 1258 },
    { "tag": "#session-summary", "count": 448 },
    ...
  ],
  "avgConfidence": 0.9998,
  "oldestEntry": "2026-05-25T10:16:17.080Z",
  "newestEntry": "2026-06-17T07:54:40.556Z",
  "staleCount": 0
}
```

**Common queries:**
```bash
tim stats | jq '.totalEntries'              # total entry count
tim stats | jq '.topTags[:5]'               # top 5 tags
tim stats | jq '.entriesByDepth'            # tree depth distribution
```

**Note:** `tim stats --help` prints usage and exits before any DB work.

---

### 4. `tim resolve-project --cwd <dir> [--format label|json|directive] [--walk-up]`

Find and return the project bound to a directory via `.tim-project` file.

**Flags:**

| Flag | Description |
|------|-------------|
| `--cwd <dir>` | Directory to search from (default: cwd) |
| `--walk-up` | Walk up directory tree to find `.tim-project` |
| `--format label` | Just the project label (e.g. `P9999`) — default |
| `--format json` | JSON with version, session, exchange count |
| `--format directive` | Full directive text for AI agent context injection |

**Examples:**
```bash
tim resolve-project --cwd ~/projects/tim
# Output: P9999

tim resolve-project --cwd ~/projects/tim --format json
# {"version":2,"project":"P9999","session":"","exchanges":0,"batch_size":5,...}

tim resolve-project --cwd ~/projects/tim --format directive
# 📍 TIM project marker detected (.tim-project in ...)
# This session is bound to TIM project P9999.
# ACTION: call tim_load_project(label="P9999") now...
```

---

### 5. `tim resolve-session --session <id> [--cwd <dir>] [--format label|directive|json]`

Get project info for a specific session ID. Requires an active session ID.

```
Usage: tim resolve-session --session <id> [--cwd <dir>] [--format label|directive|json]
```

---

### 6. `tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]`

Safely recover a missing `.tim-project` marker for an existing project. The command
resolves the exact `P` label in the selected database before it writes anything. It
writes only when no target-local marker exists, is idempotent for the same label, and
never overwrites a marker owned by a different project.

```
Usage: tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]
```

**Example:**
```bash
tim bind-project --label P0062 --cwd ~/projects/tim

# Select the exact database named by a partial-creation error:
TIM_DB_PATH='/exact/path/to/tim.db' tim bind-project --label P0062 --cwd ~/projects/tim
```

Project creation coordinates a database write with local marker publication, but it is
not cross-database/filesystem atomic. If creation reports a partial marker-publication
failure, use only its returned shell-quoted `tim bind-project` command with the same
configured database. A different existing local marker requires explicit reconciliation;
do not overwrite it.

---

### 7. `tim new-project --path <absolute-dir> --name <name>`

Preferred flow for creating a disk-backed TIM project. The command allocates a live
non-conflicting `P` label (retrying bounded concurrent collisions), creates the database
project, publishes `.tim-project`, initializes standard sections, and optionally runs
`git init`.

```bash
tim new-project --path /absolute/path/to/repository --name "Project name"
tim new-project -p /absolute/path/to/repository -n "Project name" --no-git --confirm
```

| Flag | Required | Description |
|------|----------|-------------|
| `--path <dir>`, `-p <dir>` | Yes | Repository/workspace path; `--path` must be absolute and cannot be the home directory or use shell shorthand |
| `--name <name>`, `-n <name>` | Yes | Non-empty project display name |
| `--no-git` | No | Do not initialize a Git repository |
| `--confirm` | No | Allow a non-empty directory without an interactive prompt |

Creation is coordinated, not a cross-database/filesystem transaction: the database
commit can succeed before local marker publication fails. In that case, run only the
exact returned recovery command. It includes a shell-quoted `TIM_DB_PATH` selecting the
same database used for creation. If a different marker already exists, reconcile it
explicitly; neither `new-project` nor recovery-only `bind-project` overwrites it.

---

### 8. `tim record-commit --cwd <dir> --hash <sha> --message <msg> [--diff <path>]`

Record a git commit to a project's Commits section in the TIM tree.
**WRITES to the DB** — `--help` prints usage and exits; run it only when you intend to record a real commit.

```
Usage: tim record-commit --cwd <dir> --hash <sha> --message <msg> [--diff <path>]

Note: Requires --hash and --message. Fails with "Project not found: P9999"
when run from a directory whose .tim-project points to a missing/unknown project.
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--cwd <dir>` | Yes | Project directory with `.tim-project` |
| `--hash <sha>` | Yes | Git commit hash |
| `--message <msg>` | Yes | Commit message |
| `--diff <path>` | No | Path to diff file to attach |

---

### 9-11. `tim hook session-start` / `tim hook session-end` / `tim hook log`

Session lifecycle hooks for tracking agent work sessions in TIM.

**session-start:**
```
tim hook session-start --session <id> [--agent <name>] [--cwd <path>]
                       [--harness <h>] [--project <label>] [--tool <name>] [--model <name>]
```

**session-end:**
```
tim hook session-end --session <id>
```

**session-log:**
```
tim hook log --session <id> --user <text> --agent <text>
```

**Typical workflow:**
```bash
SESSION_ID=$(uuidgen)
tim hook session-start --session $SESSION_ID --agent "claude" --cwd . --harness "claude-code"
# ... agent does work ...
tim hook session-end --session $SESSION_ID
```

---

### 12. `tim checkpoint --session <id>`

Manually trigger a checkpoint for a session — summarizes exchange batches.

```
Usage: tim checkpoint --session <id>
```

---

### 13. `tim rebalance --session <id>`

Rebalance exchange batches at boundary points — re-groups exchanges into
optimized batch sizes.

```
Usage: tim rebalance --session <id>
```

---

### 14. `tim statusline [--cwd <dir>] [--session <id>] [--format text|hermes]`

Short status string for shell prompts or Hermes TUI status bar.

**Text format** (default):
```
P9999 · 0/5 exchanges · summary in 5
```

**Hermes JSON format** (`--format hermes`):
```json
{"device":"","project":"P9999","o_node":"","counter":"0/5 · Σ5"}
```

---

### 15. `tim setup-hermes-statusline [--dry-run] [--skip-build]`

Install the Hermes TUI status bar integration. Symlinks hooks, patches `cli.py`,
builds TypeScript, and verifies the integration.

```
✓ scripts: /home/bbbee/projects/tim/packages/tim-hooks/scripts
○ symlink:tim-hermes-session-cache.sh: already linked
○ symlink:tim-hermes-statusline.sh: already linked
○ config.yaml: tim-hermes-session-cache.sh already registered
✓ hermes-cli: patched cli.py
✓ build: npx tsc -b completed
✓ verify: statusline JSON: {"device":"","project":"P9999","o_node":"","counter":"0/5 · Σ5"}

Done. Restart Hermes so cli.py changes load.
Test: bash ~/.hermes/agent-hooks/tim-hermes-statusline.sh | jq .
```

---

### 16. `tim export <path> [--format hmem|text]`

Export database to `.hmem` or plain text format.

```
Usage: tim export <path.hmem> [--format hmem|text]
```

---

### 17. `tim import <path> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]`

Import from a `.hmem` file into the live database.

```
Usage: tim import <path.hmem> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview import without writing |
| `--deduplicate` | Skip entries that already exist |
| `--repair-flags` | Repair already-imported hmem rows whose flags/tags were corrupted by an earlier migration |
| `--no-snapshot-check` | Bypass the live-import snapshot acknowledgement gate |

For hmem-to-TIM migrations, agents should follow
[`docs/hmem-to-tim-migration.md`](hmem-to-tim-migration.md) before writing to
the live TIM database.

---

### 18. `tim migrate-from-hmem <path.hmem> [--deduplicate] [--no-deduplicate] [--dry-run]`

Guided hmem-to-TIM migration for agents. It inspects the source, performs a dry
run, snapshots the TIM database before writing, imports, runs a health check,
and prints the MCP `tim_import_audit` handoff.

```bash
tim migrate-from-hmem /path/to/source.hmem --dry-run
tim migrate-from-hmem /path/to/source.hmem
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Inspect manifest and run import preview only |
| `--deduplicate` | Merge/skip matching imported labels; default |
| `--no-deduplicate` | Disable dedupe when the user explicitly wants collision remaps |

Use this command for normal hmem user migrations. Use `tim import` directly only
for focused repair or lower-level migration work.

---

### 19. `tim migrate tags-to-types [--dry-run] [--sample-limit N]`

One-time migration: convert legacy `#rule` and `#human` tags into `metadata.type`
fields. Uses heuristics to detect the correct type.

```
tim migrate <subcommand>
  tags-to-types   Convert legacy #rule / #human tags to metadata.type
                  [--dry-run] [--sample-limit N]
```

**Example:**
```bash
tim migrate tags-to-types --dry-run --sample-limit 3
# [tim] migrate tags-to-types — DRY RUN. 0 entries would be migrated.
```

**Output shows:**
- `scanned` — how many entries were scanned
- `migrated` — how many were actually changed (type set and tag removed)
- `skipped` — entries that didn't match #rule or #human
- `sampleChanges` — up to N examples of what changed

---

### 20. `tim snapshot`

Create a safe backup of the live TIM database to `/tmp/tim-snapshots/`.
Uses SQLite backup API (safe for live DB — no corruption risk).

```
snapshot: /tmp/tim-snapshots/tim-20260617-0956.db (67072000 bytes, 141ms)
{
  "ok": true,
  "target": "/tmp/tim-snapshots/tim-20260617-0956.db",
  "bytes": 67072000,
  "durationMs": 141,
  "pruned": 0
}
```

**TIP:** Run before risky operations (migrations, large imports).

---

### 21. `tim restore [--from <path>] [--list] [--dry-run] [--force]`

Restore TIM DB from a snapshot. Has a safety guard — refuses to overwrite a DB
modified within the last 60 minutes unless `--force` is passed.

```
restore: refusing to overwrite DB modified 38m ago (safety threshold 60m)
current db: /home/bbbee/.tim/tim.db
use --force to override (NOT recommended unless you know what you are doing)
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--from <path>` | Snapshot file to restore from |
| `--list` | List available snapshots without restoring |
| `--dry-run` | Show what would happen without writing |
| `--force` | Override the 60-minute safety guard |

---

### 22. `tim release-check [--beta] [--json] [--skip-tests true]`

Run the release gate sequence before tagging or packaging.

**Beta mode** adds the smoke checks after the core build/test/pack gates.
`--skip-tests true` keeps the expensive `npm test` gate out of a fast preflight
when you already ran it.

**JSON output** (`samples/tim-release-check-beta.json`):
```json
{
  "status": "OK",
  "blockers": [],
  "results": [
    { "id": "git-clean", "ok": true, "detail": "clean" },
    { "id": "build", "ok": true, "detail": "ok" },
    { "id": "tests", "ok": true, "detail": "ok" },
    { "id": "pack", "ok": true, "detail": "ok" },
    { "id": "cli-smoke", "ok": true, "detail": "ok" },
    { "id": "mcp-smoke", "ok": true, "detail": "ok" },
    { "id": "large-files", "ok": true, "detail": "ok" },
    { "id": "git-clean-after", "ok": true, "detail": "clean" }
  ]
}
```

**Note:** `tim release-check --help` prints usage and exits before any DB work.

---

### 23. `tim setup-agent --host claude|codex|cursor|hermes [--dry-run]`

Install TIM for one agent host. The command prints a JSON report covering MCP
config, copied skills, host hooks, and a doctor-style smoke status.

```bash
tim setup-agent --host codex --dry-run
tim setup-agent --host codex
```

**Host behavior:**

| Host | MCP | Skills | Hooks |
|------|-----|--------|-------|
| `claude` | Writes Claude Code JSON MCP config | Copies bundled TIM skills to `~/.claude/skills` | No extra hook install |
| `codex` | Writes `[mcp_servers.tim]` to `~/.codex/config.toml` with backup | Copies bundled TIM skills to `$CODEX_HOME/skills` or `~/.codex/skills` | No extra hook install |
| `cursor` | Writes Cursor JSON MCP config | Reports manual skill guidance | No extra hook install |
| `hermes` | Reports manual MCP guidance | Copies bundled TIM skills to `~/.hermes/skills` | Installs Hermes TIM statusline hooks |

Use `--dry-run` first when configuring a real user environment. It does not
open or create the TIM DB.

---

### 24-29. `tim sync` Subcommands

Distributed sync for multi-device TIM setups.

**`tim sync connect`**
Connects to an o9k-sync server (prompts for URL).
```
Sync server URL [http://localhost:3100]:
```

**`tim sync disconnect`**
Remove the local `sync.json` and sync-state configuration. This disconnects the
device locally; it does not delete remote data.

**`tim sync push`**
Push unacknowledged staging changes to the server.
Requires `TIM_SYNC_PASSPHRASE` env var or `--passphrase`.

**`tim sync pull`**
Pull remote changes from the server.
Requires `TIM_SYNC_PASSPHRASE` env var or `--passphrase`.

**`tim sync status`**
Show sync configuration and health:
```
═══ TIM Sync Status ═══
Server:  (✗ unreachable)
User:
File ID:
Device ID: 5c180443-ffb1-4d35-beaa-508850bace5d
Unacked staging: 7281
Last push: 2026-06-17T07:35:19.297Z
Last pull: 2026-06-17T07:35:19.338Z
Cursor: 1
Config: /home/bbbee/.tim/sync.json
```

**`tim sync dev`**
Start a local dev sync server on port 3100.
Fails with `EADDRINUSE` if one is already running.

---

### 30. `tim user init`

Create or repair the `H0000` human-profile scaffold in the selected TIM database.
This writes to the database and then prints the canonical profile sections.

### 31. `tim user profile`

Read and print the human-profile tree summary from the selected TIM database.

### 32. `tim update-skills`

Copy bundled TIM skills to detected agent-host skill directories. This mutates host
configuration directories; use `tim setup-agent --host <host> --dry-run` when you need
a non-mutating installation preview.

### 33. `tim --help`

Print the top-level command inventory without opening the TIM database.

---

## Smoke-Test Outputs

All outputs saved under `samples/`:

| File | Command | Lines |
|------|---------|-------|
| `samples/tim-doctor.txt` | `tim doctor` | 19 |
| `samples/tim-stats.txt` | `tim stats` | 100 |
| `samples/tim-resolve-project.txt` | `tim resolve-project --cwd ~/projects/tim` | 1 |
| `samples/tim-statusline.txt` | `tim statusline` | 1 |
| `samples/tim-snapshot.txt` | `tim snapshot` | 8 |
| `samples/tim-sync-status.txt` | `tim sync status` | 10 |
| `samples/tim-migrate-tags-to-types.txt` | `tim migrate tags-to-types --dry-run --sample-limit 3` | 7 |
| `samples/tim-resolve-session-help.txt` | `tim resolve-session --help` | 1 |
| `samples/tim-record-commit-help.txt` | `tim record-commit --help` | 3 |
| `samples/tim-bind-project-help.txt` | `tim bind-project --help` | 1 |
| `samples/tim-release-check-beta.json` | `tim release-check --beta --json` | 46 |
| `samples/tim-export-help.txt` | `tim export --help` | 1 |
| `samples/tim-import-help.txt` | `tim import --help` | 1 |
| `samples/tim-hook-help.txt` | `tim hook --help` | 5 |
| `samples/tim-restore-help.txt` | `tim restore --help` | 5 |

---

## Common Workflows

### How to record a commit

```bash
# 1. Commit your changes in git
git add -A
git commit -m "fix(parser): handle edge case in depth calculation"

# 2. Record in TIM
HASH=$(git rev-parse HEAD)
MSG=$(git log --format=%s -1)
tim record-commit --cwd . --hash "$HASH" --message "$MSG"
```

**Pitfall:** `tim record-commit` requires that the `.tim-project` in the cwd
point to a valid project entry. If the project doesn't exist in the DB, it fails
with `Project not found: PXXXX`.

### How to check what project is bound

```bash
# Simple label output
tim resolve-project --cwd .

# JSON with full state
tim resolve-project --cwd . --format json

# Walk up the tree to find the project marker
tim resolve-project --walk-up
```

The project marker file `.tim-project` contains a single line like `P9999`.
TIM walks up from your current directory looking for this file.

### How to recover a missing project marker

```bash
# Recover the marker for an exact live project label
tim bind-project --label P0062 --cwd ~/projects/tim

# Or with a session
tim bind-project --label P0062 --session <session-id>
```

This resolves the exact label in the selected database and writes `.tim-project` only
when the directory has no marker. Repeating it for the same label is idempotent. It
never replaces a different local marker; reconcile that conflict explicitly instead.

### How to read a specific entry

The CLI doesn't have a built-in `tim read` command — use the TIM MCP tools instead.
Configure your MCP client with `~/.tim/mcp.json`:

```json
{
  "mcpServers": {
    "tim": {
      "command": "npx",
      "args": ["tim-mcp"],
      "env": { "TIM_DB_PATH": "/home/bbbee/.tim/tim.db" }
    }
  }
}
```

Then call from your MCP client:
```
tim_read(id="01KV...")
tim_load_project(label="P0062")
tim_search(query="something specific")
```

### How to search

Again, search is primarily an MCP tool, but you can use `tim doctor` and
`tim stats` to discover tags and navigate the data:

```bash
# See all available tags
tim stats | jq '.topTags'

# Use the MCP tools via a configured client:
#   tim_search(query="bug fix", project="P0062")
#   tim_search(tags=["#exchange"], limit=10)
```

### How to write a new entry

Writing is MCP-only via `tim_write`. The CLI does not have a direct `tim write`
command (designed as an orchestration tool, not a manual editor).

### Health check before starting work

```bash
# Quick health overview
tim doctor

# Database stats
tim stats | jq '{entries: .totalEntries, edges: .totalEdges, oldest: .oldestEntry}'

# Verify safe state
tim snapshot   # backup before risky operations
```

### Session lifecycle (for automated workflows)

```bash
SESSION_ID=$(uuidgen)

# Start session
tim hook session-start --session $SESSION_ID --agent "claude" --cwd . --harness "claude-code"

# ... agent works, logging exchanges via MCP ...

# End session (triggers checkpoint + summary)
tim hook session-end --session $SESSION_ID

# Check result
tim resolve-session --session $SESSION_ID --format json
```

---

## Tips & Gotchas

### Important Gotchas

1. **`--help` is now intercepted for the core DB-opening commands.** `init`,
   `doctor`, `stats`, `import`, `export`, `record-commit`, `checkpoint`,
   `rebalance`, `snapshot`, `restore`, `root-entries`, and `statusline` print
   usage and exit before touching the database. `sync dev` still executes
   immediately.

2. **`tim sync dev` may crash** with `EADDRINUSE` if a dev server is already running
   on port 3100.

3. **`tim record-commit` writes to the DB.** It is still a mutating command, but
   `--help` now stops before the DB opens. You still need a valid project binding
   when you actually run it.

4. **`tim restore` has a 60-minute safety window.** If the DB was modified in the
   last 60 minutes, it refuses to restore unless `--force` is passed.

5. **Orphan entries in `tim doctor` are normal** — they accumulate from session
   checkpointing. 7201 orphans with 2750 entries isn't unusual.

### Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `TIM_DB_PATH` | MCP & CLI | Override DB location (default: `~/.tim/tim.db`) |
| `TIM_SYNC_PASSPHRASE` | `sync push/pull` | Passphrase for sync authentication |

### Paths & Locations

| Path | Description |
|------|-------------|
| `~/.tim/tim.db` | Main TIM database (SQLite) |
| `~/.tim/mcp.json` | MCP server config for npx tim-mcp |
| `~/.tim/sync.json` | Sync configuration |
| `/tmp/tim-snapshots/` | Snapshot backup location |
| `~/.tim/projects/<label>.json` | Per-project cache (created by MCP) |
| `packages/tim-cli/dist/cli.js` | CLI entry point |
| `packages/tim-mcp/dist/server.js` | MCP server entry point |

### Format Flags

Commands that support `--format`:

| Command | Formats |
|---------|---------|
| `resolve-project` | `label` (default), `json`, `directive` |
| `resolve-session` | `label`, `directive`, `json` |
| `statusline` | `text` (default), `hermes` |
| `export` | `hmem` (default), `text` |

### Quick Reference Card

```
Diagnostics:    tim doctor, tim stats
Navigation:     tim resolve-project, tim resolve-session
Binding:        tim bind-project
Recording:      tim record-commit
Sessions:       tim hook session-start/end, tim checkpoint, tim rebalance
Status:         tim statusline
Data Mgmt:      tim export, tim import, tim migrate
Safety:         tim snapshot, tim restore
Sync:           tim sync {connect,push,pull,status,dev}
Setup:          tim init, tim setup-hermes-statusline
```

---

*Generated 2026-06-17 from live TIM DB (2750 entries).*
*Commit: 7b15407 (feature/tim-update-title-fix)*
