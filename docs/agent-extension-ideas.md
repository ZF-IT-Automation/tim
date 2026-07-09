# Agent Extensions

This note tracks agent-facing skills and MCP tools that make TIM safer to use
during beta migrations and daily agent work.

## Shipped Skills

- `tim-release-beta`: pre-release checklist for beta tags, npm pack dry-run,
  install smoke test, docs check, and GitHub release notes.
- `tim-project-curate`: project-structure cleanup flow after large imports or
  long agent sessions; covers duplicate sections, stale Next Steps, and task
  status normalization.
- `tim-sync-triage`: sync incident workflow for queue state, pull/push status,
  passphrase checks, and safe retry order.
- `tim-secret-audit`: verify secret subtrees before sharing, syncing, exporting,
  or inviting external collaborators.
- `tim-mcp-smoke`: confirm a host can see the TIM MCP tools and perform
  read/search/write without touching user data.
- `tim-hmem-import-audit`: verify hmem-imported project structure and guide
  manual repair without SQL.

## Shipped MCP Tools

- `tim_import_audit`: structured post-import report for project roots, expected
  sections, orphaned imported nodes, duplicate sections, missing labels, and
  repair suggestions.
- `tim_project_structure`: returns one project's section tree with ids,
  metadata.kind, child counts, and imported hmem provenance.
- `tim_repair_section`: safe helper to create canonical sections and move
  children into them without raw SQL.
- `tim_import_manifest`: list labels and counts found in a `.hmem` file before
  import, so agents can compare source versus TIM after import.
- `tim_dry_run_move`: validate `tim_move_entry` operations and show depth/order
  changes before writing.

The current safe hmem migration path is the `tim-hmem-import-audit` skill plus
these MCP tools: `tim_import_manifest`, `tim_import`, `tim_import_audit`,
`tim_project_structure`, `tim_repair_section`, `tim_dry_run_move`,
`tim_move_entry`, `tim_read`, `tim_update`, `tim_link`, and `tim_doctor`.

## Still Worth Considering

- `tim_release_check`: MCP/CLI equivalent of `tim-release-beta`.
- `tim_mcp_smoke`: self-contained tool that performs a read-only server smoke
  test and reports missing capabilities.
- `tim_sync_triage`: structured queue/auth/backoff report for sync incidents.
