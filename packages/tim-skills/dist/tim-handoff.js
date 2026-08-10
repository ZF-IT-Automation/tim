"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIM_HANDOFF_SKILL = void 0;
exports.TIM_HANDOFF_SKILL = {
    name: 'tim-handoff',
    description: 'Prep for /clear — save a handoff note via the tim CLI checkpoint, update the open tasks, then clear. Use before ending long sessions.',
    content: `# TIM Handoff

Before \`/clear\`, leave a durable handoff so the next session starts better.

## Steps

1. **Git gate:** If you edited tracked files this session, ensure repos are clean (commit/stash) before handoff.
2. **Handoff note:** Write it as \`done: … | wip: … | next: …\` and save it with the CLI:
   \`\`\`
   tim checkpoint --session <sessionId> --handoff-note "done: … | wip: … | next: …"
   \`\`\`
   There is no \`tim_checkpoint\` MCP tool — only the CLI writes a note. Get the session id from
   \`~/.tim/claude-session\`, or from the newest session of the bound project.
3. **Tasks:** Update the project's Tasks section via \`tim_update\` (read → merge → update).
4. Tell the user to \`/clear\` when the checkpoint confirms.

## What must survive

The note is read by an agent with no memory of this session, so spend the words on what it cannot
reconstruct — not on a tidy summary:

- **Unpushed or uncommitted work**, by branch and commit, and whether CI has seen it.
- **A decision and why the alternative lost.** The next session will otherwise re-litigate it.
- **What is deliberately parked** and on whose word — mark anything waiting on the user, so the
  next agent does not "helpfully" start building it.
- **What was measured versus assumed.** A claim nobody verified must say so.
- **Backups and rollback paths** for anything destructive that was done.

Keep it dense, not long. Do not duplicate the automatic checkpoint's summary of what was discussed —
that text is already rendered in the next briefing.
`,
};
//# sourceMappingURL=tim-handoff.js.map