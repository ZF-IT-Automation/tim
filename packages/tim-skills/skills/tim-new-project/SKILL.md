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
   Replace every apostrophe with `'"'"'`, then wrap the whole value in apostrophes.
   Example: `TIM_DB_PATH='/srv/Agent DB'"'"'s/tim.db' tim new-project --path
   '/absolute/repository' --name 'Project name'`. The CLI owns label allocation/retry,
   creation, marker publication, and sections.
4. Call `tim_load_project`, then fill the appropriate seeded sections with TIM tools.

If `tim_doctor` cannot provide a persistent database path, do not guess. Ask the user.

`tim new-project` always takes `--path`. Never use `memoryOnly=true` for an unknown cwd;
resolve the canonical path first. A database-only project is a user decision, not a fallback.

If project creation reports a partial marker-publication failure, run only the exact
shell-quoted `tim bind-project` command it returns, against the same configured database.
If a different local marker exists, require explicit reconciliation and never overwrite it.
