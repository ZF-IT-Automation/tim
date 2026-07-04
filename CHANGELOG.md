# Changelog

All notable changes to TIM are documented in this file.

## [Unreleased]

### Added

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
