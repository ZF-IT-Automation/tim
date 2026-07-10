# Review: Commits 165ce60, 15067d9, c5a95db

Reviewed on 2026-07-10.

Scope:
- `165ce60` — merge: `feature/fix-cron-exchange-bugs`
- `15067d9` — merge: `fix/import-project-kind`
- `c5a95db` — merge: contrary project review

## Findings

### P1: Session-start marker rotation interpolates untrusted values into `node -e`

File: `packages/tim-hooks/scripts/tim-session-start.sh:56`

`cwd` and `hook_session` are interpolated directly into a JavaScript program passed to `node -e`. A project path or session id containing `'`, backslashes, or newlines can break marker rotation, and the failure is hidden by `2>/dev/null || true`.

Pass these values via argv or environment variables instead of embedding them in the script string.

Note: `165ce60` itself is tree-empty against its first parent; this finding applies to the merged/equivalent hook content, not to a new tree delta in the merge commit.

### P2: Codex output contract is inconsistent with the script header

File: `packages/tim-hooks/scripts/tim-session-start.sh:15`

The header still says `Codex CLI -> plain text directive`, but the implementation emits JSON `{context: ...}` for any payload with `session_id` at line 88. If Codex expects plaintext, this is a regression. If JSON is correct, the script documentation is stale.

There should be a direct regression test for the actual Codex/Hermes payload shapes.

### P2: No explicit backfill path for already imported project roots

File: `packages/tim-cli/src/cli.ts:496`

`15067d9` fixes new imports and deduplicating re-imports, but it does not add an explicit backfill command for existing DBs with imported `P*` roots missing `metadata.kind = "project"`.

The commit message says existing DBs need a one-off backfill. The CLI currently exposes `--repair-flags`, but not a project-kind repair. Users who already imported data can remain in the exact crash state the commit describes.

### P3: Merge artifact duplicates the same project-kind assignment and assertion

Files:
- `packages/tim-migrate/src/import.ts:353`
- `packages/tim-migrate/src/import.ts:361`
- `packages/tim-migrate/src/__tests__/import.test.ts:117`
- `packages/tim-migrate/src/__tests__/import.test.ts:121`

The import metadata object sets `kind: "project"` twice for the same `P` prefix condition, once through `shouldMarkAsProjectRoot(e.prefix)` and once through `e.prefix === "P"`. The test also asserts `meta.kind` twice.

This is not a runtime bug, but it is a clear merge-cleanup issue and makes the test less precise.

### P3: `REVIEW-contrary.md` contains stale repo-state claims

File: `REVIEW-contrary.md:141`

The review claims `node_modules/` is tracked with 4,818 files. In the current merge state, `git ls-files 'node_modules/*' 'packages/*/node_modules/*'` returns `0`.

As a historical review this can be fine, but in the repo root it reads like a current finding. The header or filename should make the time-bound nature explicit, or the stale facts should be updated.

### P3: `165ce60` is a no-op merge by tree

Commit `165ce60` has the same tree as `15067d9`.

That means the merge commit brings no functional tree changes, while its message suggests hook/helper changes. This makes later audits noisier because the merge appears to be the carrier of changes that were already present.

## Verification

Commands run:

```bash
npx vitest run packages/tim-migrate/src/__tests__/import.test.ts
bash -n packages/tim-hooks/scripts/tim-session-start.sh
git rev-parse 165ce60^{tree} 15067d9^{tree}
```

Results:
- `packages/tim-migrate/src/__tests__/import.test.ts`: 14/14 tests passed.
- `tim-session-start.sh`: syntax check passed.
- `165ce60^{tree}` and `15067d9^{tree}` are identical.
