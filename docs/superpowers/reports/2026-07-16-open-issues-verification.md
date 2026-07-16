# Open Issues Remediation — Verification Evidence

Date: 2026-07-16  
Branch: `fix/open-issues`  
Worktree: `/home/bbbee/projects/tim/.worktrees/fix-open-issues`  
Base compared: `1eccf19`  
HEAD at verification: `332defd`

This report records command outputs from Task 11. It does **not** close GitHub issues.

## Commands run

### 1. Marker invariance + full suite

```bash
before=$(sha256sum .tim-project 2>/dev/null || true)
npm test
after=$(sha256sum .tim-project 2>/dev/null || true)
test "$before" = "$after"
```

Result:

| Check | Value |
|---|---|
| Marker before | `cad7cfe414121443ff5b19c56792a7daffc0ef629fab4ea850d539d5a2345a57  .tim-project` |
| Marker after | `cad7cfe414121443ff5b19c56792a7daffc0ef629fab4ea850d539d5a2345a57  .tim-project` |
| Marker invariant | pass |
| Full suite | `Test Files  155 passed (155)` / `Tests  1188 passed \| 2 skipped (1190)` |
| Duration | 36.39s |

### 2. Build and lint

```bash
npm run build && npm run lint
```

Result:

- `npm run build` → exit 0 (`tsc -b`)
- `npm run lint` → exit 0 (`tsc -b --noEmit`)

After review finding that Task 9/10 left stale `dist/` artifacts, a forced rebuild was committed:

```bash
rm -f packages/*/tsconfig.tsbuildinfo && npm run build
# committed as 332defd chore: sync dist artifacts for Claude hook adapters
```

### 3. Targeted issue suites

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

Result:

```
Test Files  9 passed (9)
     Tests  203 passed (203)
Duration  13.01s
```

### 4. Generated MCP smoke

Temporary `HOME` + `TIM_DB_PATH`. Entry from `buildTimMcpEntry`:

```json
{
  "command": "/home/bbbee/.local/share/cursor-agent/versions/2026.07.13-7fe37d2/node",
  "args": ["/home/bbbee/projects/tim/.worktrees/fix-open-issues/packages/tim-mcp/dist/server.js"],
  "env": { "TIM_DB_PATH": "<tmp>/tim.db" }
}
```

JSON-RPC responses (snip):

```json
{"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"tim-mcp","version":"0.1.0-alpha"}},"jsonrpc":"2.0","id":1}
{"result":{"content":[{"type":"text","text":"{\n  \"totalEntries\": 0, ... }"}]},"jsonrpc":"2.0","id":2}
```

`initialize` + `tim_stats` succeeded against the executable MCP entry.

### 5. Claude hooks install smoke (temp HOME only)

`tim setup-agent --host claude --dry-run` reports:

```json
"hooks": { "action": "would-install-claude-hooks" }
```

`installClaudeHooks({ settingsPath: <tmp>/.claude/settings.json })` against pre-existing unrelated settings:

```json
{
  "install": {
    "status": "installed",
    "settingsPath": "<tmp>/.claude/settings.json",
    "backupPath": "<tmp>/.claude/settings.json.backup.<ts>"
  },
  "hasPrompt": true,
  "hasStop": true,
  "permissions": { "allow": ["Bash"] }
}
```

No writes were made to the real `~/.claude/settings.json` or `~/.tim/tim.db` during this verification.

## Review notes (Tasks 8–11)

Cross-cutting review over Tasks 8–11 found:

| Severity | Finding | Resolution |
|---|---|---|
| IMPORTANT | Stale committed `dist/` caused `claude-stop` CLI tests to fail from a clean checkout after `npm run build` alone | Fixed in `332defd` (forced rebuild + commit dist / tsbuildinfo) |
| MINOR | Redundant `readMarker` fallback in `ensureSessionForStop` | Removed |
| MINOR | `cwd.trim()` checked but untrimmed cwd used | Trimmed before marker lookup / logging |
| MINOR | Marker session vs payload sessionId cadence edge case | Documented; pre-existing helper contract; not blocking |

Verdict after fixes: **APPROVE** for merge readiness of Tasks 8–11 implementation evidence. Issue closure remains a separate authorization step.

## Issue mapping (evidence only — not closure)

| Issue | Theme | Evidence present? | Notes |
|---|---|---|---|
| #3 | Marker / stdio isolation / read-only bind | Yes | `error-contract`, `load-project-bind`; marker sha unchanged across full suite |
| #4 | Inbox P0000 repair | Yes | `session.test.ts` (45 tests) in targeted suite |
| #5 | Bounded `tim_search` | Yes | `search-response.test.ts` (8 tests) |
| #6 | Installer executable MCP / CLI help / relocatable hooks | Yes | `install.test.ts`, `help-safety.test.ts` (107), MCP smoke initialize+`tim_stats` |
| #7 | Claude `UserPromptSubmit` producer | Yes | `prompt-submit-hook.test.ts` (12); dry-run + settings merge smoke |
| #8 | Claude Stop exchange logging | Yes | `claude-stop` unit+CLI tests; idempotent duplicate delivery; skill no longer instructs `tim_session_log` |

## Commits added for Tasks 8–11 on this branch

```
332defd chore: sync dist artifacts for Claude hook adapters
344c572 feat(cli): install Claude prompt and Stop hooks
e34eeaa feat(hooks): log Claude Stop exchanges idempotently
4cd7bd5 fix(cli): drain oversized hook input
581aeb3 feat(cli): add Claude prompt-submit hook adapter
```

Cherry-pick source for Task 8: `fix/prompt-submit` commits `1965b2f` and `39d35f6` (resolved `dist/cli.js.map` conflict by continuing after source merge; later rebuilt in `332defd`).
