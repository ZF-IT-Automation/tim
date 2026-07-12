# /tim-resume — Cross-Tool Session Resumption

**Date:** 2026-07-12
**Status:** Approved design, pending implementation plan

## Problem

When a session hits its limit (e.g. Claude Code session cap), the user loses the working
context. TIM already stores everything needed to continue — raw exchanges, batch summaries,
session summary — but there is no way to load a previous session into a *new* harness session
(Cursor, Codex, or a fresh Claude session) and keep appending to the same session node.
Today a new harness session always creates a new session node, fragmenting the history.

## Goal

A `/tim-resume` slash command (skill) usable from any TIM-integrated tool that:

1. Presents the last N sessions of the bound project for selection
2. On selection, injects resume context via a tool call: session summary + all batch
   summaries + the last 10 raw exchanges
3. Binds the new harness session to the old session node via alias, so all further
   exchanges append to the old node (continuous seq, seamless summarizer) instead of
   creating a new session node

## Non-Goals

- No cross-project session listing (bound project only)
- No visible "resumed here" marker exchange in the log (metadata only)
- No migration/resume support for legacy flat sessions (no `exchanges-root` subtree) —
  these are rejected with a clear error
- No token-budget-adaptive payload sizing (fixed counts with optional parameters)
- No changes to how sessions are *created* (`tim_session_start` stays untouched)

## Design Decisions (settled with user)

| Decision | Choice |
|---|---|
| Session selection scope | Last N sessions of the bound project (default 10 listed) |
| Append mechanism | Alias mapping: new harness ID stored in `metadata.resumed_by[]` on the old session node; old ID stays canonical |
| Payload sizing | Fixed: last 10 raw exchanges + ALL batch summaries + session summary; `rawCount` parameter for tuning |
| Summarizer behavior after resume | Seamless continuation — new exchanges land in the last open batch, seq continues, no marker exchange |
| Marker behavior | `.tim-project` marker rotates back to the canonical (old) session ID after resume |

## Architecture

Three layers, matching existing package boundaries:

```
tim-skills/skills/tim-resume   — presentation protocol for the agent (any harness)
tim-mcp                        — tim_resume_list + tim_session_resume tool wrappers
tim-store                      — resolveSessionId, SessionManager.resumeSession,
                                 listResumableSessions (all logic + tests here)
```

### 1. Store layer (`packages/tim-store`)

#### `resolveSessionId(harnessId: string): string`

Central alias resolution. If `harnessId` is not itself a `kind=session` node, look up a
session whose `metadata.resumed_by` array contains `harnessId`; return that session's
canonical ID. Otherwise return the input unchanged (identity for non-aliased IDs).

Called at the entry points of `logExchange`, `showUnsummarized`, `checkpoint`,
`sessionLog`, and any other API that takes a session ID from the harness. One resolution
point, no scattering. Lookup via a metadata query (`json_each` over `resumed_by` or an
equivalent indexed lookup); performance is uncritical (one lookup per hook invocation).

#### `SessionManager.resumeSession(oldSessionId, opts)`

`opts: { newHarnessId: string; tool?: string; model?: string; rawCount?: number }`

Steps:
1. Validate `oldSessionId` is a `kind=session` node with an exchanges-root subtree;
   otherwise throw with a clear message (covers legacy flat sessions)
2. Guard: if `newHarnessId` already identifies a session node **with exchanges** — and
   is not `oldSessionId` itself (self-resume after /clear is allowed) — throw
   (refuse to orphan an active session); if it identifies an empty auto-created session
   node, that node is left in place and simply never used again (acceptable debris,
   cleaned by decay)
3. Append `newHarnessId` to `metadata.resumed_by[]` (idempotent — no duplicates),
   set `metadata.resumed_at` (ISO timestamp), update `metadata.tool` / `metadata.model`
   when provided (previous values preserved in `metadata.tool_history[]`)
4. Return the resume payload:

```ts
interface ResumePayload {
  sessionId: string;              // canonical (old) ID
  sessionMeta: { project, date, tool_history, exchange_count, task_summary? };
  sessionSummary: string;         // content of the summary-root node
  batchSummaries: Array<{ batchIndex, seqFrom, seqTo, text }>;  // all, sorted by batch_index
  recentExchanges: Array<{ seq, userContent, agentContent }>;   // last `rawCount` (default 10), ascending seq
  warnings: string[];             // e.g. "no batch summaries yet — summarizer may be behind"
}
```

#### `listResumableSessions(projectId: string, limit = 10)`

Sessions under the project's Sessions section, sorted by last activity (most recent
exchange or session `date`), each with: canonical ID, date, tool, `task_summary`,
`exchange_count`, and the first line of the session summary (empty string if none).

### 2. MCP layer (`packages/tim-mcp`)

#### `tim_resume_list { projectId?: string, limit?: number }`

Defaults to the bound project. No bound project and no `projectId` → respond with the
existing inbox-fallback guidance pattern. Output: numbered list, one session per line —
date, tool, task summary, exchange count, summary first line — plus an ACTION line
instructing the agent to present the list and call `tim_session_resume` with the chosen ID.

#### `tim_session_resume { sessionId: string, rawCount?: number }`

- Derives `newHarnessId` from the current harness session (`TIM_SESSION_ID` env /
  hook context), `tool`/`model` from server context where available
- Calls `SessionManager.resumeSession`
- Calls `rotateMarkerSession(cwd, sessionId)` so the `.tim-project` marker points at the
  canonical session — hooks that read the marker route correctly
- Formats the payload as a single markdown block:

```
## Resumed Session <title> (<date>, <tool>)
<session meta line>

## Session Summary
<summary text>

## Batch Summaries (N)
### Batch 1 (seq 1–10)
...

## Last 10 Exchanges (raw)
[seq 42] USER: ...
[seq 42] AGENT: ...

ACTION: Context restored. Continue the conversation from here; all further
exchanges append to this session automatically.
```

Registered in the session-tool group (same wiring as `tim_session_start` etc.).

### 3. Skill layer (`packages/tim-skills/skills/tim-resume`)

Harness-agnostic skill / slash command, distributed like the existing tim-skills:

1. Call `tim_resume_list`
2. Present the numbered list to the user (date, tool, task, short summary) and ask which
   session to resume — do not auto-pick unless the user already named one
3. On choice, call `tim_session_resume` with the chosen session ID
4. Treat the returned payload as loaded context — do NOT paraphrase it back in full;
   confirm briefly: "Resumed session from <date> — last state: <one line>"
5. If the payload carries warnings (no summaries), mention them in one line

## Data Flow After Resume

```
Cursor session (new harness ID H2)
  └─ Stop hook logs exchange with TIM_SESSION_ID=H2
       └─ resolveSessionId(H2) → S1 (old canonical session)
            └─ logExchange(S1, …) → last open batch, seq continues
                 └─ batch fills → onBatchFull → summarizer writes Batch N+1 as usual
```

The session node's `resumed_by: [H2]`, `tool_history: ["claude-code", "cursor"]`
document the tool transition; the exchange log itself stays continuous and unmarked.

## Edge Cases

| Case | Behavior |
|---|---|
| No bound project | Inbox-fallback guidance from `tim_resume_list` |
| Parallel resume of one session from two tools | Allowed — both aliases in `resumed_by`; `logExchange` runs in `runExclusive`, seq stays consistent |
| Session without batch summaries | Payload returns raw exchanges + warning; resume additionally triggers the unsummarized-sweep (best-effort, non-blocking) |
| Legacy flat session (no exchanges-root) | `resumeSession` throws: "Session uses legacy format and cannot be resumed" |
| `newHarnessId` already has its own session with exchanges | `resumeSession` throws with hint to start fresh or resume from the *other* session |
| Resume of the *current* session (old ID == new harness ID) | No-op alias-wise; payload still returned (useful after /clear) |
| Fewer than 10 exchanges in session | Return all of them |

## Testing

**tim-store — `session-resume.test.ts`:**
- `resolveSessionId`: identity for unknown/canonical IDs; resolves aliased ID; resolves after multiple aliases
- `resumeSession`: payload contains session summary, all batch summaries in order, exactly last `rawCount` exchanges ascending; `resumed_by` idempotency; guard throws for harness ID with existing non-empty session; legacy-session rejection; `tool_history` accumulation
- Seq continuity: log exchanges → resume with new ID → log via new ID → seq continues, exchanges land in same batch, `exchange_count` correct
- Parallel resume: two aliases, interleaved logs, no seq collision

**tim-mcp:**
- Tool registration + schema for both tools
- `tim_resume_list` formatting incl. empty-project and no-binding fallback
- `tim_session_resume` output block formatting + marker rotation call

**Regression:** all existing session/summarizer/hook tests must pass unchanged —
`resolveSessionId` is identity for non-aliased IDs.

## Rollout Notes

- No schema migration needed (`resumed_by` is plain metadata)
- Sync: `resumed_by` travels inside entry metadata like any other field — no sync-server change
- Skill distribution follows the existing tim-skills install path for Claude Code /
  Cursor / Codex
