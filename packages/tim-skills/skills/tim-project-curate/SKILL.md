---
name: tim-project-curate
description: Clean up TIM project structure after imports or long agent sessions.
---

# tim-project-curate

Use when a project tree looks messy.

Read first:
1. `tim_project_structure({ label })`
2. `tim_load_project({ label, bind:false, depth:3 })`
3. `tim_doctor`

Fix order:
- Missing canonical section → `tim_repair_section({ project:label, title })`.
- Child under wrong parent → `tim_dry_run_move`, then `tim_move_entry`.
- Duplicate section → move useful children into canonical section; mark duplicate
  irrelevant only after user agrees.
- Wrong content/metadata → `tim_read`, merge, then `tim_update`.
- Broken relation → recreate with `tim_link` only when source/target are clear.

Never use direct SQL. End with `tim_project_structure` + `tim_doctor`.
