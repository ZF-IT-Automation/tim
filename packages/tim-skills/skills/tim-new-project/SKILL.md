---
name: tim-new-project
description: Create a TIM project with an explicit repository path or intentional memory-only mode.
---

# tim-new-project

Use when an agent must create a project in the configured live TIM database.

For a disk-backed repository or workspace:
1. Resolve one canonical absolute path for the repository/workspace.
2. Call MCP `tim_doctor`; obtain and verify its exact active database path is persistent.
3. Prefer the shell-safe `TIM_DB_PATH='<doctor-db-path>' tim new-project --path <absolute-path> --name <name>`.
   Replace placeholders and single-quote/escape shell
   values. The CLI owns label allocation/retry, creation, marker publication, and sections.
4. Call `tim_load_project`, then fill the appropriate seeded sections with TIM tools.

If `tim_doctor` cannot provide a persistent database path, do not guess. Use direct MCP
only with an already-known non-conflicting label as below, or ask the user.

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
