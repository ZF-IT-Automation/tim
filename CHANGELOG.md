# Changelog

All notable changes to TIM are documented in this file.

## [Unreleased]

### Added

- **Topic recall** — past work is retrieved by topic instead of injected by recency.
  - The summarizer prompt now carries the tags the project has actually reused, frequency-ordered, with the instruction to reuse a fitting one verbatim before inventing a new one (`TimStore.projectTagVocabulary`, `UnsummarizedBatch.vocabulary`). A failed lookup leaves the prompt unchanged.
  - `aggregateSessionTags` uses a batch-count dependent bar — every content tag up to two batches, twice-seen from three on — so short sessions stop losing their topics.
  - `tim_search` accepts `tag` without `query`: a tag lookup returning everything carrying it, oldest first. With both, the tag stays a filter on the ranked results.
  - New MCP tool `tim_resume_topic(topic)` and skill `/tim-resume-topic`: batch summaries across the matching sessions in chronological order, the tasks/bugs/ideas on the same topic, and — from the newest matched session only — its handoff note and uncovered raw turns. A newest session without a note says so; it never falls back to an older one.
  - New skill `/tim-continue` renders the previous session's briefing on demand via `tim_preview_briefing`.

- **`.tim-ignore`** — a directory holding this file belongs to no project, and the marker walk-up stops there instead of inheriting a binding from a parent. For unattended runners (cronjobs under `$HOME`, benchmark repos) whose sessions are harness noise rather than project history.

### Changed

- **Tags name subjects, not activities.** The summarizer asked for "3-5 content hashtags" and said nothing about what a tag is; on a batch about one subject that forces padding, and padding is where one-off tags come from — 407 of the 509 distinct tags on batch summaries were used exactly once. It now asks for 1-3, requires at least one to name a feature, subsystem or subject that could have its own file or spec, and rules out containers and the project's own name. Activity is a closed list of four words (`#design #implementation #debugging #review`), at most one, because free-form activity words are where the drift actually lived: `#bugfix`, `#bugfixing`, `#bug-fixing` and `#codefix` all coexist in one project, as do seven spellings of managing skills.
- **The vocabulary hint no longer recommends bookkeeping.** `projectTagVocabulary` excludes the machine-stamped commit tags (`#commit` alone carries 229 entries in P0063 and headed the frequency-ordered list the prompt tells the model to prefer), and the summarizer path takes only tags used at least twice. The unfiltered histogram stays available to callers measuring drift.

- **The session briefing falls back to the batch summaries.** Its source cascade was the rollup on the Summary root, then the newest checkpoint's text, then the root's body — and if all three were empty it went to the raw turns, which are only the turns no summary covers. Measured across the 312 sessions that have batch summaries: 21 have no rollup, 13 of those have no usable checkpoint either, and for all 13 the raw tail is empty as well, because every exchange is already covered by a batch summary. Those 13 briefed completely empty while carrying up to 3010 characters of batch summaries that nothing ever read. The cascade now ends at the batch summaries, in the order they happened.

- **Topic recall renders one block per session, not per batch.** A batch is an artifact of the summarizing cadence — nobody worked "in batch 3" — and rendering batches separately reprinted a session's intermediate states as if each were its conclusion. Measured on the live view for "tim-viewer": one session contributed three batches, the third of which says outright that the earlier decisions are superseded, while the two superseded ones were rendered above it with equal authority. A reader who stops early reads decisions that were overturned in the same session. Each session now contributes its Summary root's rollup, which is written across all of that session's batches and has therefore already resolved the supersession; a Summary root is consequently a first-class hit rather than a footnote, since it carries the session's aggregated tags and matches topics its individual batches never spell out. The sessions whose Summary root is empty fall back to their matching batch summaries — 21 of 312 after the backfill — and the session line says which of the two it is showing. Measured: "tim-viewer" 9487 → 6276 characters, "summarizer" 19167 → 10485.

- **A session rollup no longer reads its batch summaries unbounded.** `buildSessionRollupPrompt` concatenated them raw; the worst of the 312 sessions that have batch summaries fed 52,617 characters into the model, on a path that runs at every session end. Each batch now gets an equal share of `ROLLUP_INPUT_MAX_CHARS` (20000) rather than the early batches being dropped to fit — a rollup accounts for the whole session, and the later batches assume the earlier ones.

- **Batch summaries have a length budget.** The prompt asked for themes, decisions and open items and said nothing about length, so the summaries drifted with the model: across the 445 in the live database the median is 915 characters, the top decile passes 2715 and the longest is 4953. Length only became a cost once summaries were read in bulk — a topic recall renders ten at once, and one call spent 33k characters. `BATCH_SUMMARY_MAX_CHARS` (1200) now goes into the prompt, together with what to sacrifice first: prose and detail, never a decision or an open item, since a model asked only to be shorter drops the structured tail that the next session actually reads. Readers cut at `BATCH_SUMMARY_RENDER_CHARS`, 20% above the budget, so a summary that obeyed the limit is never truncated; the cut falls on a line boundary, drops a heading it would otherwise leave empty, and names the `tim_read` that shows the rest.

- **`tim_resume_topic` takes a topic, not a tag.** Retrieval by tag alone required the caller to already know the name someone coined, and measured against the live database that is exactly what nobody knows: the viewer work is tagged `#tim-inspector`, so `#tim-viewer` returned nothing while full text found the same batch summaries by their bodies. It now searches the tag scan and FTS together and unions the results — the tag scan is exhaustive where the ranked search truncates, so neither replaces the other. Three details the union needed: raw exchanges are excluded in SQL rather than filtered afterwards, or `LIMIT` returns a page of untagged user turns instead of summaries; a hyphenated topic is split into its words, because FTS5 reads a quoted `"sync-server"` as an adjacent phrase and matched no batch summary in P0063 at all; and output is capped to the newest sessions (`limit`, default 10) but still rendered oldest first, with a line naming how many of how many were shown.

- **The automatic session start no longer injects past work.** `collectDirectiveBriefing` takes `includePastWork`: the two start-hook callers pass `false`, so a fresh session gets the project header, open work and the binding instruction; `tim_preview_briefing` passes `true`. The previous session used to be chosen by recency alone, which made it noise in every session about something else. Use `/tim-continue` for the last session, `/tim-resume-topic` for a subject.

### Fixed

- **Structural counts are taken by kind, not by tag.** A batch summary carries `#session-summary` as well as `#batch-summary`, so `searchByTag('#session-summary')` returns the session roots and their batches together. Several figures in this changelog and in the code comments around the summarizer were first measured that way and were inflated: 984 Summary roots where there are 385, 553 batch summaries where there are 445, 336 sessions with batch summaries where there are 312. The numbers above are the corrected ones, taken with `getByMetadataKind`. Nothing shipped was wrong — the 13 empty briefings and the one poisoned rollup are both confirmed by the clean measurement — but the denominators were.

- **Both catch-up sweeps see every session.** `showAllUnsummarized` and `showUntagged` scanned `getByMetadataKind(KIND_SESSION, 100)`. The cap was invisible below a hundred sessions and silently blinded both once past it: at 377 sessions they could not see 277, including every session that had logged five or more exchanges and never been summarized.

- **The summarizer no longer logs its own prompts back into TIM.** Its process tree is marked with `TIM_SUMMARIZER=1`, and the hook entry points (`tim hook <sub>`, the start directive) no-op under that flag — the agent CLI the summarizer runs is otherwise a hook-registered session of its own, so its prompt was stored as a user exchange and fed the next summarizer run.

## [0.1.0-beta.1] — 2026-07-19

### Changed

- **Marker v3 (binding-only)** — `.tim-project` is now `{version, project}` only. Session id and counters live in the store (`resolveCurrentSession`, `deriveCounters`). Summarizer lock moved to `.tim/summarizer.lock`.
- **`tim bind-project`** — backfills `metadata.path` when absent and seeds per-device `project-path` inventory rows.
- **`tim doctor --bind`** — binding health report; opt-in flag binds only `unbound` findings via `recoverProjectBinding`.
- **hmem migration** — closes with per-project binding-state report; runbook/skills require bind-before-done (never hand-write markers).

## [0.1.0-beta.0] — 2026-07-19

First public beta. GitHub repo is public; npm packages publish under the `beta` dist-tag (`npm install tim-cli@beta`). Expect breaking changes.

### Added

- **Idea lifecycle & coding tasks** — ideas track `metadata.idea.status` with in-place promote to task when status → `planned`. Coding tasks add `subtype`, `commits`, `changes_pending` status, and `needs_review` filter on `getTasks` / `tim_show`.
- **Append-only task status history** — `metadata.task.history` is an append-only event log (ISO `at`, optional `by`/`note`); `metadata.task.status` caches the last entry. Coding `done` requires prior `reviewed` in history; `commits` and `pushed` status are required only when `metadata.task.vcs === 'git'` (worktree detection, not "git installed"). Replaces boolean `reviewed` gate.
- **Cross-tool session resumption (`/tim-resume`)** — `tim-store`: `resolveSessionAlias`, `SessionManager.resumeSession`, `listResumableSessions`, alias-transparent session APIs (`logExchange`, `showUnsummarized`, etc. resolve harness ids). `tim-mcp`: new tools `tim_resume_list`, `tim_session_resume`. `tim-skills`: new skill `tim-resume`.
- **Hybrid search** — `entry_vectors` table (migration v10, device-local), fastembed-based embedding hook (`tim-hooks`), three-signal re-rank in `search()` (FTS5 + cosine similarity + graph/usage/staleness boost). `TIM_EMBEDDING_DISABLED=1` disables entirely.
- **Summary-first reads** — `tim_read` returns `summary` by default (500 chars or `metadata.summary`); full content only with `include_body=true`.
- **Retrieval benchmark harness** — `runBenchmark()` with precision@3, recall@5, MRR; golden query suite in test.
- **`tim_load_project(bind:false)`** — read a project without binding the session; the canonical replacement for cross-project lookups previously done via `tim_read_project`. Also adds `sessionId` to `tim_load_project` (was already on the zod schema, now visible in ListTools).
- **`errorResult` helper** — every failure path in the MCP handler returns `isError:true` with a helpful text payload (e.g. `"Entry not found: NOPE-000"`, `"Project not found: P9999"`). Replaces the old `"null"` text returns and the silent text-only failure paths that broke JSON clients.
- **`Entry.updatedAt`** — top-level field on read/write responses; mirrors DB `updated_at` (bumps on content edits and on `tim_verify`).
- **`tim_verify`** — re-confirm entries as still valid without editing content; stamps `metadata.verified_at`, bumps `updated_at`, stages sync upsert.
- **Memory trust annotations on `tim_read`** — non-schema entries may include `stale` (`lastVerified`, `daysSince`) and/or `provenance_drift` (`commitsSince`) when age or git drift exceeds thresholds.
- **`HealthReport.staleEntries`** — count of unverified knowledge entries older than `TIM_STALE_DAYS` (default 90); surfaced in `tim_health` issues list.
- **Git commit provenance on `tim_write`** — best-effort `metadata.provenance` (`commit`, `branch`, `captured_at`) from agent cwd; set `TIM_PROVENANCE=0` to disable.
- **Write-time dedup on `tim_write`** — refuses near-duplicate knowledge titles (Jaccard ≥ 0.6, project-scoped when parent set) with `duplicate_suspected` + candidate list; `force:true` bypasses; `TIM_DEDUP_CHECK=0` disables; schema kinds exempt.
- **`SCHEMA_KINDS` moved to `tim-core`** — shared set of structural entry kinds (sessions, sections, tasks, …); exempt from staleness annotations and provenance capture.
- **Retrieval usage-feedback loop** — device-local `entry_usage` table records reads (`tim_read`, `tim_search`) and references (`tim_update`, `tim_link`, id cited in same-session `tim_write`); `search()` re-ranks with `position − 2·log2(1 + referenced)`; `TIM_USAGE_RANKING=0` disables the re-rank. The table is deliberately excluded from staging/sync/export (privacy — usage is a per-device relevance signal, not shared knowledge).
- **`tim_guard`** — pre-action check against negative memory (`kind` error/learning or `#error`/`#learning` tags); returns warnings with entry ids or `status: clear`.
- **`tim_delta`** — project diff since previous session (`created`/`updated`/`deleted`), default baseline = previous session `updatedAt`, 7-day fallback, 500-row cap; supplement to `tim_load_project`, not a replacement.

### Changed

- **Task status resolution (`tim_show`, project briefing badges)** — both renderers now share `resolveEntryTaskStatus()` and read only `metadata.task.status`. Legacy top-level `metadata.status` on task entries is ignored; entries with `{ task: true, status: 'done' }` appear as `[todo]` until migrated to `{ task: { status: 'done' } }`.
- **ListTools inputSchemas** — now derived from zod via `zod-to-json-schema`. Param descriptions ported verbatim; previously-invisible zod params (`tim_write.title`, `tim_session_start.tool`/`model`/`taskSummary`, `tim_move_entry.order`) are now visible.
- **`tim_read_project`** — description marked `[DEPRECATED — use tim_load_project with bind:false]`; handler unchanged for backward compatibility (still works as alias).

### Fixed

- **`.tim-project` in shared directories** — hooks never trust or write markers under `os.tmpdir()` or the filesystem root (cron cwd=`/tmp` was poisoning every walk-up under `/tmp`).
- **`tim_load_project(bind:false)` marker mutation** — marker sync runs only on binding loads; read-only loads leave existing markers byte-identical and create none when absent.
- **MCP test marker hygiene** — child servers use an isolated temp cwd so the suite no longer rewrites the repo checkout (or live `/tmp`) `.tim-project`.
- **Idea-promote / coding-task follow-ups** — vcs auto-detection before `pushed` gate; memoized caller project path; promote on metadata object (no write-path JSON roundtrip); shared Tasks retarget helper; `createProject` skips idea-promote; order recompute after promote retarget.
- **Usage ranking on label paths** — `tim_update`/`tim_link` now pass the store-resolved entry id to `markReferenced`, so usage feedback works when callers use hmem-style labels (e.g. `L0042`) instead of composite ids.
- **`tim_guard` German queries** — `searchFailures` splits action text on Unicode-aware word boundaries so umlauts (ü/ö/ä/ß) are not stripped before FTS lookup.
- **`tim_update` metadata** — partial metadata patches preserve system-managed fields (`verified_at`, `provenance`) and deep-merge `metadata.task` instead of replacing the whole object.
- **`tim_read` not-found paths** — used to return `JSON.stringify(null)` (text `"null"` without `isError:true`), which broke clients that grepped the response for content. Now returns `isError:true` with `"Entry not found: <id>"`.
- **`tim_load_project` / `tim_read_project` failure paths** — ambiguous alias, project not found, and load-gate rejection now return `isError:true`. Previously only `tim_load_project` ambiguous path returned `isError:true`; the others returned silent text-only responses.
- **`tim_sync` / `tim_lease` / `tim_import` failure paths** — sync-not-configured, sync-action-not-implemented, agent-not-registered, missing-grant-or-revoke, source-not-found now return `isError:true` instead of silent text.

### Deprecated

- **`tim_read_project`** — superseded by `tim_load_project(label, bind:false)`. Will be removed in a future release.

### Removed

- **`tim_rename_title`** — outright removal (breaking). Use `tim_update(id, title)` for title-only edits. The handler was a thin wrapper over `s.update(id, { title })` so all clients have a drop-in replacement.
- **`tim_tasks`** — outright removal (breaking). Use `tim_show(what="tasks", with="open,done,...")` for the same overview; status filtering moves from `status=` to `with=`.

### Changed

- **`tim_tasks`** — description marked `[DEPRECATED — use tim_show what='tasks']`; handler unchanged for backward compatibility.
