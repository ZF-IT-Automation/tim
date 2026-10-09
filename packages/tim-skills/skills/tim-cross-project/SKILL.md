---
name: tim-cross-project
description: Use when a task changes or needs another project than the one this session is bound to — its code, CLI, API, MCP tools, files or env. Research and edits there go to a worker started in that project's repo, never this session.
---

# tim-cross-project

Any project, related or not. A = this session's project, B = the other one.

## No worker needed
B's Interfaces entry (`tim project interfaces <B>`) already answers the question → read it, done.

## Otherwise: a worker in B
Never research or edit B from this session — B's rules, tests and TIM briefing only load in B's repo.
1. Find B's repo: the header of B's Interfaces entry, else the directory whose `.tim-project` names B (`grep -l '"<B>"' ~/projects/*/.tim-project`).
2. Where the worker runs: research only → B's checkout. Changes → a full `git clone` of B on a new branch, never B's checkout (another session may be working there). Before dispatch: copy B's `.tim-project` into the clone (often gitignored) and install its dependencies.
3. Spawn the worker there:
   - `team-up` on PATH → its `dispatch` skill, Path B, with `--dir <that dir>`. The worker starts in B, so B's AGENTS.md / CLAUDE.md, `.tim-project` and TIM briefing load by themselves.
   - otherwise a native subagent. Its prompt says: read B's AGENTS.md / CLAUDE.md first, then `tim_load_project({ label: "<B>", bind: false })` and B's Interfaces entry; work only inside that dir.
4. The worker's prompt carries: the goal in B, what A needs from B (exact interface shape), both Interfaces node IDs, done = B's tests green + the new Interfaces text in its report.
5. TIM writes stay with this session: `tim project interfaces <B> --set` from the worker's report, findings via `tim_write` into B. The worker reports, it does not write memory. Merge and push of B's branch are this session's call, and the human's.
6. Order: B (the provider) extends its interface first, then A adapts and updates its own Interfaces entry if it changed.
7. Relate A ↔ B (skill `tim-relate-projects`) only when they really belong together (recurring work). A one-off task needs no edge.
