# JOURNAL — marker + directive fixes (2026-06-03)

## Decisions
- findMarker: collect chain, skip `~/.tim-project` when deeper marker exists, else deepest wins.
- Directive display: `resolveProjectBindingLabel` (uncropped); `tim_load_project(label=)` stays bare P-label.
- tim-session-start.sh: project label from `tim resolve-project`, not first marker file on walk.

## Edge cases
- Cwd with only home marker (no repo `.tim-project`) still binds home — walk cannot see repo.
- Corrupt nearest marker still returns null (no ancestor fallback).
- DB miss → binding falls back to label only.

## Gotchas
- Rebuild `tim-cli` / `tim-hooks` dist before hook picks up changes (`TIM_CLI` path).
- MCP still writes `~/.tim-project` on load — repo marker + findMarker skip is the real fix.
- Tests: use `TIM_MARKER_MAX_ROOT` — real `~/.tim-project` leaks without it.
