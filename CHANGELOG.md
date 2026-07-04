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

### Changed

- **ListTools inputSchemas** — now derived from zod via `zod-to-json-schema`. Param descriptions ported verbatim; previously-invisible zod params (`tim_write.title`, `tim_session_start.tool`/`model`/`taskSummary`, `tim_move_entry.order`) are now visible.
- **`tim_read_project`** — description marked `[DEPRECATED — use tim_load_project with bind:false]`; handler unchanged for backward compatibility (still works as alias).

### Fixed

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
