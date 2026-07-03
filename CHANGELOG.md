# Changelog

All notable changes to TIM are documented in this file.

## [Unreleased]

### Added

- **`tim_load_project(bind:false)`** — read a project without binding the session; the canonical replacement for cross-project lookups previously done via `tim_read_project`. Also adds `sessionId` to `tim_load_project` (was already on the zod schema, now visible in ListTools).
- **`errorResult` helper** — every failure path in the MCP handler returns `isError:true` with a helpful text payload (e.g. `"Entry not found: NOPE-000"`, `"Project not found: P9999"`). Replaces the old `"null"` text returns and the silent text-only failure paths that broke JSON clients.

### Changed

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
