Fix ALL Plan 12D review findings per Fable review.

## 🔴 CRITICAL 1: Custom Initialize handler breaks MCP handshake

**File:** `packages/tim-mcp/src/server.ts` (commit 3359a85)
**Bug:** Registers custom handler for InitializeRequestSchema, replacing SDK's built-in handler. This echoes back request.params.protocolVersion blindly (claims support for any version), skips SDK bookkeeping (client capabilities not stored, server capabilities not sent). AutoInit is already called in createMcpServer() — second call in handler is redundant.
**Fix:** Remove the custom InitializeRequestSchema handler entirely. If AutoInit needs to run per-connect, use server.oninitialized or wrap to pass through to SDK handler.
**Test:** Verify MCP handshake still works: client connects, negotiated version is correct, getClientCapabilities() returns data.

## 🔴 CRITICAL 2: PromptSubmit retrieval ignores searchType: 'fts'

**File:** `packages/tim-store/src/store.ts` (commit 8570da0)
**Bug:** prompt-submit.ts calls `store.search({ query, searchType: 'fts' })` but store.search() never reads searchType. It always does full hybrid path — loads fastembed + embedding model on EVERY user prompt. With embeddings in the DB, retrieval always times out within 1s budget, but model loading CPU/RAM spike still runs in background.
**Fix:** Actually evaluate searchType in store.search(). When searchType='fts', skip the vector branch entirely (no fastembed import, no cosine similarity).
**Test:** Search with searchType='fts' on a DB that has vectors — verify no embedding model loaded, results returned within budget.

## 🟠 MEDIUM: Auto-Project creates projects for /tmp, ~, task dirs

**File:** `packages/tim-hooks/src/checkpoint.ts`
**Bug:** ensureProjectForPath() creates a project for ANY directory without .tim-project — including ~, /tmp, task dirs. No blocklist. Makes Inbox fallback unreachable. Two parallel sessions can get same label (nextAutoProjectLabel not atomic). Same basename at different paths binds to same project.
**Fix:** Add blocklist (os.homedir(), /tmp, /var/tmp, patterns starting with ~/projects/tasks/). Make label assignment atomic. Add opt-out config flag.
**Test:** Verify no project created in /tmp, ~, /task-dir. Verify atomic label assignment.

## 🟡 MEDIUM
- Update check compares wrong package version (tim-hooks package.json vs tim-mcp npm). Fix: read version from tim-mcp/package.json or use consistent source.
- Update check blocks session start up to 3s — add timeout race (500ms) like other briefing parts.
- getDeltaBriefing/runPromptSubmit: clear setTimeout on completion to avoid event loop hold.
- runAutoInit: check if agent already registered before calling registerAgent.

## Branch
feature/fix-plan-12d-review from master
Write RESULT.md + JOURNAL.md to ~/projects/tasks/task-review-12d-fixes/
All existing 844 tests must still pass. Add new tests for each fix.
