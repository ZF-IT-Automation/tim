---
name: tim-hmem-import-audit
description: After tim_import of a .hmem file, verify project structure and repair misplaced nodes without SQL.
---

# tim-hmem-import-audit

Use after `tim_import` of a .hmem file.

Rules:
- No direct SQL. Use TIM tools only.
- Keep the original import report and source path in the handoff.
- If structure is unclear, ask before moving entries.
- Binding: for each imported project, `tim bind-project --label P#### --cwd <dir>` (ask user when metadata.path absent) or record intentionally memory-only; never hand-write `.tim-project`.

Audit:
1. Read import report: check warnings, remapped, skipped.
2. Run `tim_doctor` or CLI `tim doctor`; note broken links/orphans and binding lines.
3. For each imported project label (P####), call
   `tim_load_project({ label:"P####", bind:false, depth:3 })`.
4. Confirm expected sections exist: Overview, Context, Decisions, Tasks,
   Bugs/Errors, Log, Next Steps, Ideas, Rules.
5. Spot wrong shape: project missing, sections as root entries, children under
   wrong project, old level_2..5 chains collapsed oddly, hidden important nodes.

Repair:
- Missing section: `tim_write({ where:"P####", title:"Tasks", metadata:{kind:"section"} })`.
- Wrong parent: `tim_move_entry({ id, newParentId })`.
- Wrong title/body/tags/metadata: `tim_read({ id })` first, then `tim_update`
  with merged data.
- Duplicate section: move useful children into canonical section, then suppress
  or mark obsolete/irrelevant only after user agrees.
- Broken links: recreate with `tim_link` when source/target are clear.

Verify again:
- `tim_load_project({ label:"P####", bind:false, depth:3 })`
- `tim_doctor`
- `tim_import(source, { dryRun:true, deduplicate:true })`

Handoff:
source path | snapshot path | import counts | projects checked | bindings resolved |
repairs made | remaining warnings | MCP restart needed.
