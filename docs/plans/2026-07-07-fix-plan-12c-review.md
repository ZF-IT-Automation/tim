Fix ALL Plan 12C review findings per the Fable review:

## 🔴 CRITICAL 1: FTS trigger deletes on secret entries corrupt database

**File:** `packages/tim-store/src/schema.ts:270`
**Bug:** The new FTS triggers skip inserting secret entries into the index, but the delete legs of `entries_au` and `entries_ad` unconditionally fire the FTS5 'delete' command — even for rows that were never indexed. On an external-content FTS5 table, deleting a non-indexed row is illegal and produces "database disk image is malformed".
**Fix:** Add same guard to delete legs: only delete from FTS index when old row was NOT secret (`json_extract(old.metadata,'$.secret') IS NULL OR json_extract(old.metadata,'$.secret') = 0`).
**Test:** Create entry with secret:true, UPDATE it, DELETE it — no malformed error.

## 🔴 CRITICAL 2: Sync of secret entries crashes pull on receiving device

**File:** `packages/tim-sync-client/src/sync.ts` `encryptSecretPayload()`
**Bug:** `encryptSecretPayload()` rebuilds the payload object keeping only id, parent_id, created_at, updated_at, depth, title, content, metadata. It drops tags, content_type, accessed_at, confidence, decay_rate, visibility, irrelevant, tombstoned_at. `decryptSecretPayload()` only spreads the stripped object — fields never come back. On the receiving device `applyRemoteEntry()` binds these missing fields as NULL in INSERT OR REPLACE, but content_type, accessed_at, tags are NOT NULL → constraint error, sync hangs permanently.
**Fix:** Keep ALL fields in the encrypted payload. Only encrypt title, content, metadata. Keep everything else (tags, content_type, accessed_at, etc.) in cleartext alongside the encrypted blob.
**Test:** Sync a secret entry between two devices, verify applyRemoteEntry succeeds.

## 🟠 HIGH: Placeholder echo overwrites real data

**Bug:** A device without secretPassphrase stores the placeholder ("🔒 [secret]", empty content) as a real row. If that row is later touched (update, curation, re-staging), the device pushes the placeholder as a normal unencrypted envelope back with a newer LWW timestamp. Other devices then overwrite real data with the placeholder.
**Fix:** Add guard in push path: skip staging records where content matches placeholder pattern.
**Test:** Create placeholder, push it → skipped, not sent to server.

## 🟡 MEDIUM
- `packages/tim-store/src/curate.ts:265`: `materializeSecretSubtreeSync` runs AFTER transaction commit, not inside it. Move inside transaction. Use actual device ID (`this.deviceId`) instead of hardcoded `'local'`.
- `tim secret set <non-existent-id>` shows "✓ Secret set" with count 0 masked as 1.
- No `tim secret unset` command — document that secret is one-directional.
- `rowHasSecret()` in secret.ts parses same JSON string twice — deduplicate.

## Branch
feature/fix-plan-12c-review from master
Write RESULT.md + JOURNAL.md to ~/projects/tasks/task-review-12c-fixes/
All existing 844 tests must still pass. Add new tests for each fix.
