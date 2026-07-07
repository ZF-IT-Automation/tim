---
name: tim-handoff
description: Prep for /clear — save handoff note via tim_checkpoint, update Next Steps, then clear. Use before ending long sessions.
---

# TIM Handoff

Before `/clear`, leave a durable handoff so the next session starts better.

## Steps

1. **Git gate:** If you edited tracked files this session, ensure repos are clean (commit/stash) before handoff.
2. **Handoff note:** Write 3 lines — done / in progress / next step. Pass to checkpoint:
   ```
   tim_checkpoint(sessionId, handoff_note="done: … | wip: … | next: …")
   ```
3. **Next Steps:** Update the project's Next Steps section via `tim_update` (read → merge → update).
4. Tell the user to `/clear` when the checkpoint confirms.

Keep the note short. Do not duplicate auto-checkpoint content.
