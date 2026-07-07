Fix ALL Plan 12E+F review findings per Fable review.

## PRE-FIX: .gitignore cleanup

Add to .gitignore and remove from tracking:
- `local_cache/` (90 MB ONNX model + tokenizer files)
- `node_modules/` (already in .gitignore but committed stale node_modules changes)
- Any `._*` AppleDouble files

**DO NOT delete the actual local_cache/ directory** — just stop tracking it. Use `git rm --cached -r local_cache/`.

## 🔴 CRITICAL 1: Entry updates never propagate to already-synced devices

**File:** `packages/tim-sync-server/src/storage.ts`
**Bug:** `pushBlobs()` does in-place UPDATE on existing blob rows. `pullBlobs()` paginates via index cursor (rows.slice, sorted by id ASC). When device A updates entry E (blob row 5), device B pulls from cursor 100 → never sees the change. Also `has_more` hardcoded false, pull always loads entire blob table into RAM.
**Fix:** Change push to append-only: on update, insert NEW blob row with same client_proposed_id. Change pull to use timestamp-based cursor (updated_at) instead of row count. Set has_more correctly.
**Test:** Two devices: A pushes, B pulls, A updates, B pulls again → B sees the update.

## 🔴 CRITICAL 2: /register is wide open — Pro tier free, no rate limit

**File:** `packages/tim-sync-server/src/server.ts`
**Bug:** POST /register requires no auth. Client chooses its own tier (`{"tier":"pro"}` → unlimited quota). Every registration creates a tenant DB file → anonymous disk exhaustion.
**Fix:** Server assigns tier (default free). Add rate limiting on /register (e.g. max 5/hour per IP). Add admin endpoint for pro tier promotion.
**Test:** Register without auth → gets free tier. Register 6 times in an hour → rate limited.

## 🔴 CRITICAL 3: Repo hygiene — 90 MB ONNX model committed

Already handled by PRE-FIX .gitignore step.

## 🟠 HIGH

- **No request body limit:** `readBody()` accumulates unlimited data into string. Add max body size (e.g. 10MB) before quota check.
- **installMcpForHosts() can clobber ~/.claude.json:** If existing config isn't parseable, `existing = {}` overwrites file. Fix: abort on parse error, create backup before write.
- **Unauthenticated /health opens all tenant DBs:** `aggregateStats()` opens every tenant's SQLite file. Fix: require admin token for /health, or limit to simple uptime/count without per-tenant iteration.

## 🟡 MEDIUM

- `tim sync disconnect` deletes sync.json but not sync state (cursor survives). Add cursor + state cleanup.
- Idempotency check outside transaction: two parallel pushes with same key both pass seen-check. Move check inside transaction.
- `getTenantDb()` opens/closes SQLite per request: open once per tenant per request scope.

## Branch
feature/fix-plan-12ef-review from master
Write RESULT.md + JOURNAL.md to ~/projects/tasks/task-review-12ef-fixes/
All existing tests must pass. Add new tests for each fix.
