---
name: tim-new-project
description: Create a TIM project with an explicit repository path or intentional memory-only mode.
---

# tim-new-project

Use when an agent must create a project in the configured live TIM database.

For a disk-backed repository or workspace:
1. Resolve one canonical absolute path for the repository/workspace.
2. Prefer `tim new-project --path <absolute-path> --name <name>`. The CLI owns
   label allocation/retry, database creation, marker publication, and section setup.
3. Call `tim_load_project`, then fill the appropriate seeded sections with TIM tools.

If directly using MCP, start only with an already-known non-conflicting `P` label and
call `tim_create_project` with `label`, `content`, `aliases`, and
`path="/absolute/path/to/repository"`. On collision, retry only under an explicit,
known allocation policy. If no supported allocator/list is available, do not guess:
use the CLI or ask the user. Accept success only when the result has `mode="bound"`
and its `markerPath` is the `.tim-project` path for that same canonical repository.

Use `memoryOnly=true` only for an intentionally virtual/database-only project.
Never use `memoryOnly=true` for an unknown cwd; resolve the canonical path first.

If project creation reports a partial marker-publication failure, run only the exact
shell-quoted `tim bind-project` command it returns, against the same configured database.
If a different local marker exists, require explicit reconciliation and never overwrite it.
