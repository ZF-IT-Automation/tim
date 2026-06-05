# Changelog

All notable changes to TIM are documented in this file.

## [Unreleased]

### Added

- **`tim_show`** — unified overview tool with `what` (tasks, errors, bugs, ideas, decisions, learnings, commits, sections, all), `root` (project scope or `all`), `with` filters (open, done, urgent, recent, tags, free-text FTS), and `limit` applied last after scoping.
- **Store query methods** — `listProjects()`, `getByTag()`, `getByMetadataType()`, `getProjectLabel()` for overview tooling without raw SQL in MCP handlers.
- **`tim_read` extensions** — optional `project` and `section` params; batch read via `id` array returning `{ entries, missing }`; single-string `id` keeps `{ entry, edges }` shape.
- **`tim_search` extensions** — post-filter by `root`, `type`, `tag`, `status`; `topK` applied last when filters present.
- **`tim_write` `where` shorthand** — `where: "P0062/Tasks"` resolves project + section to `parentId` (explicit `parentId` wins).

### Changed

- **`tim_tasks`** — description marked `[DEPRECATED — use tim_show what='tasks']`; handler unchanged for backward compatibility.
