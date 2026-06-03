# JOURNAL — P0063 bugs (2026-06-03)

## Decisions
- FIX 1: merge label/alias into `search()` via `resolveProjectLabel`, not FTS migration (comment in store.ts for future).
- FIX 2: throw on duplicate label; tombstoned/irrelevant rows excluded from guard.
- FIX 3: `requireProject()` centralizes validation; session + commit use it.
- FIX 0 deploy: `tim-mcp` `bin` → workspace `dist/server.js`; `~/.tim/mcp.json` points at repo `.bin` (npx 404 on npm registry).
- Live dedupe: tombstone stub `ubun-0603-ns-01KT6DRBQF...`; curate `irrelevant:false` on canonical `01KSTQ4AB1...` (was hidden).

## Edge cases
- `store.update({ irrelevant: false })` broken: `patch.irrelevant ? 1 : existing` treats false as unset — use `curate().updateMany` or fix update separately.
- Canonical P0063 had `irrelevant=1` (hmem import?) — not just duplicate stub.
- `search("P0063")` with broken resolve still returns FTS noise from content mentioning P0063.
- `topK` enforced via `.slice(0, topK)` after label prepend.

## Gotchas
- Restart MCP host after mcp.json change (path was `npx tim-mcp` → E404).
- Sync may re-push stub/tombstone; check other devices.
- Live verify script uses built `tim-store/dist`, not MCP process until restart.
