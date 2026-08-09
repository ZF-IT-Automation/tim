"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIM_PROJECT_CURATE_SKILL = void 0;
exports.TIM_PROJECT_CURATE_SKILL = {
    name: "tim-project-curate",
    description: "Clean up TIM project structure after imports or long agent sessions.",
    content: `# tim-project-curate

Use when a project tree looks messy. Curation is not "tidy until it looks nicer":
it is bringing the tree to the target state and leaving every deviation either
fixed or written down. One project at a time. Never use direct SQL.

**Read \`TARGET-STATE.md\` next to this file first** — it lists the invariants (R1-R7
root, S1-S4 sessions, C1-C3 content) that define "curated". Everything below is how
to reach them.

Then read: 1. \`tim_project_structure({ label })\` (the R2-R6 report) 2.
\`tim_load_project({ label, bind:false, depth:3 })\` 3. \`tim_find_duplicates({ label })\`
(C3 candidates, enqueued not deleted) 4. \`tim_doctor\`.

Fix order — each step assumes the ones above it are done:

- Doctor \`unbound\`/\`label-mismatch\` finding → confirm directory with user, then \`tim bind-project\`; never overwrite a mismatched marker without explicit user decision.
- Missing canonical section → \`tim_repair_section({ project:label, title })\`. Never
  for \`Sessions\`/\`Commits\`: those are \`managed: true\` and materialize themselves by
  kind, so creating them by title is what produces the duplicate (R6).
- Duplicate managed root (R4) → keep the one with children, move children off the
  others with \`tim_dry_run_move\` then \`tim_move_entry\`, then delete the emptied ones.
  Both have children → merge into the older one, it holds the inbound edges.
- Duplicate section (R5) → same shape: move useful children into the canonical
  section, then delete the empty duplicate.
- Loose direct child (R3) → move it into the section it belongs to. No body and no
  children (C2) → delete it instead of finding it a home.
- Wrong content/metadata → \`tim_read\`, merge, then \`tim_update\`. \`tim_update\` replaces
  the body: read it first or you erase what you meant to extend.
- Duplicate content (C3) → merge into the older node, delete the newer.
- Broken relation → recreate with \`tim_link\` only when source and target are clear.

Before any delete:

- \`childCount: 0\` is not proof of emptiness — most lookups filter \`irrelevant = 0\`.
  Re-check with \`tim_read({ id, showIrrelevant: true })\`. Deleting a root whose
  children are only hidden is the one move here that loses memory.
- Soft delete by default (\`tim_delete\` without \`hard\`) — reversible. \`hard: true\`
  only for nodes you are certain are noise.
- Deletes do not cascade: children of a deleted node become unreachable. Move them
  out first, or delete them explicitly.
- Deletes sync. They reach other devices; this is not a local-only cleanup.
- Structure you may fix on your own judgement. Anything with a body: ask first.

End with \`tim_project_structure\` + \`tim_doctor\`, and report per invariant what now
holds and what you deliberately left alone.
`,
};
//# sourceMappingURL=tim-project-curate.js.map