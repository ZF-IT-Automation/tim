# hmem to TIM Migration Runbook

This document is for agents helping a user move from an existing `.hmem`
database to TIM. Treat it as an operational runbook, not background reading.

## Goal

Move hmem memory into TIM's local SQLite database without losing data, hiding
entries, or writing to the wrong database.

The migration path is local-only. TIM sync is optional and out of scope for this
runbook.

## Rules For Agents

- Do not edit `~/.tim/tim.db` or any `.hmem` file with raw SQL.
- Do not run an import into the live TIM database before a successful dry run.
- Do not skip the TIM snapshot step unless the user explicitly accepts that risk.
- Do not use `--force` for normal migration. It bypasses the idempotency guard
  and can intentionally duplicate imported content.
- Prefer `--deduplicate` when importing into a TIM database that may already
  contain matching labels.
- Keep the source `.hmem` file unchanged. The import opens it read-only.
- Report any `warnings`, `remapped`, or unexpected `skipped` counts to the user.

## What TIM Imports

TIM supports the two known hmem database shapes:

- v2 `.hmem`: `entries`, `nodes`, and `links`
- old `.hmem`: `memories`, plus optional `memory_nodes` and `memory_tags`

Imported rows get `metadata.hmemUid`, which makes re-running the same import
idempotent. Existing labels can be merged with `--deduplicate`; hard ID
collisions are remapped to new TIM IDs and reported.

## Preflight

Run these commands from any shell where `tim` is available:

```bash
tim migrate-from-hmem /path/to/source.hmem --dry-run
tim doctor
tim stats
tim import /path/to/source.hmem --dry-run --deduplicate
```

If `tim` is not on `PATH`, use the built CLI from the repo:

```bash
node packages/tim-cli/dist/cli.js migrate-from-hmem /path/to/source.hmem --dry-run
node packages/tim-cli/dist/cli.js import /path/to/source.hmem --dry-run --deduplicate
```

Stop and ask the user before continuing if the dry-run report has:

- `"format": "unknown"`
- source file open errors
- warnings about skipped nodes or links that the user cares about
- unexpectedly low `newCount`
- unexpectedly high `remapped`

## Backup

Before writing, snapshot the current TIM database:

```bash
tim snapshot
```

Keep the printed snapshot path. If rollback is needed, use:

```bash
tim restore --from /tmp/tim-snapshots/<snapshot-file>.db --dry-run
tim restore --from /tmp/tim-snapshots/<snapshot-file>.db --force
```

Use `--force` for restore only when the user confirms rollback.

## Import

For the normal hmem to TIM migration, run:

```bash
tim migrate-from-hmem /path/to/source.hmem
```

That wizard performs the agent-safe sequence in one command:

1. inspect the source manifest
2. run a dry import with deduplication enabled
3. snapshot the TIM database
4. run the live import
5. print the MCP `tim_import_audit` handoff
6. run a TIM health check
7. print a per-imported-project binding report (`bound` / `unbound` / `no-path` / etc.)
8. print a final handoff summary

Use the lower-level import command only when you need a narrower operation:

```bash
tim import /path/to/source.hmem --deduplicate
```

Read the JSON report:

- `entriesImported`: root hmem entries written to TIM
- `nodesImported`: child nodes written to TIM
- `edgesImported`: links written to TIM
- `skipped`: already-imported or deduplicated rows
- `remapped`: ID or label collisions rewritten to new TIM IDs
- `warnings`: skipped or malformed source data

Re-running the same command is expected to import little or nothing because
`metadata.hmemUid` is used as the idempotency key.

## Repair Old Flag Corruption

Some early migrations wrote wrong `irrelevant` / `favorite` flags and lost tags.
If the user previously imported hmem data and many migrated entries disappeared,
repair against the original `.hmem` source:

```bash
tim import /path/to/source.hmem --repair-flags --dry-run
tim import /path/to/source.hmem --repair-flags
```

This matches already-imported TIM rows by `metadata.hmemUid`. It does not
resurrect entries deleted in the source `.hmem`.

## Verification

After import, run:

```bash
tim doctor
tim stats
tim import /path/to/source.hmem --dry-run --deduplicate
```

The final dry run should mostly show already-imported or deduplicated content.
Investigate any new warnings before declaring the migration done.

Then run the `tim-hmem-import-audit` skill if it is available. It tells the
agent how to verify imported project structure and repair misplaced nodes with
TIM tools only, never direct SQL.

If the import used `tim migrate-from-hmem`, read the printed `audit` block and
run the listed MCP tool call before declaring the migration complete.

If TIM MCP tools are available, prefer this structured sequence:

```text
tim_import_manifest(source)
tim_import(source, dryRun:true, deduplicate:true)
tim_import(source, deduplicate:true)
tim_import_audit(source)
tim_project_structure(label)
tim_repair_section(...) / tim_dry_run_move(...) / tim_move_entry(...)
```

If the MCP client will use TIM immediately, verify the TIM MCP config too:

```bash
tim init
tim doctor
```

Then restart the MCP client so it reads the TIM server config.

## Bind Imported Projects

After import, the migration wizard prints a `bindings` block with one line per
hmem-imported project (`metadata.hmemUid` present). Each line shows the binding
state on this device: `bound`, `unbound`, `no-path`, `path-missing`, or
`label-mismatch`.

For every imported project:

1. If `metadata.path` points at the correct repository on this machine and the
   line is `unbound`, run:
   ```bash
   tim bind-project --label P#### --cwd /absolute/path/to/repo
   ```
2. If `metadata.path` is absent or wrong, ask the user for the directory, then
   bind with `tim bind-project` or record the project as intentionally
   memory-only in the handoff.
3. If the line is `label-mismatch`, stop and reconcile with the user — never
   overwrite a different project's marker without an explicit decision.
4. Never hand-write `.tim-project` files. `tim bind-project` is the only safe
   marker-writing path for migration repair; it backfills `metadata.path` and
   seeds the path inventory when needed.

Re-run `tim doctor` after binding. Use `tim doctor --bind` only to auto-bind
`unbound` findings when the path is already correct — it never fixes
`label-mismatch` or `path-missing`.

## Handoff Summary

When finished, tell the user:

- source `.hmem` path
- TIM DB path from `tim doctor`
- snapshot path created before import
- import report counts
- per-project binding lines from the wizard `bindings` block (or `tim doctor`)
- remaining warnings or remaps
- whether `--repair-flags` was run
- whether MCP client restart is still needed

If anything failed, do not improvise with direct database edits. Use the snapshot
for rollback or ask for the next decision with the exact report output.
