---
name: tim-session-start
description: TIM session lifecycle — start, bind project, log exchanges.
---

# tim-session-start

## Session lifecycle
1. **Start** — the host hook does this. From a shell: `tim hook session-start --session <id> [--project <label>] [--cwd <path>] [--harness <name>]`.
   It returns the session node and binds the project when `--project` or a cwd `.tim-project` is present.
2. **Load brief** — `tim_load_project({ label: "P0063", bind: true, sessionId })`
   Loading another project re-binds the session there (follow the work); an unbound session binds on its first `tim_write`. Cross-project read without re-binding → `bind: false`.
3. **End** — the harness session-end hook checkpoints automatically. To leave a note yourself, use
   the CLI: `tim checkpoint --session <sessionId> --handoff-note "…"`.

## Hooks (automatic)
- SessionStart briefing may include delta + update line (no extra calls).
- The UserPromptSubmit hook injects retrieval context. Do not call it yourself.
- Installed Claude hooks log exchanges automatically — do not call internal logging tools.

## Inbox fallback (P0000)
If no project bound, response includes ACTION to `tim_load_project` a real project.
