export const TIM_CONTINUE_SKILL = {
  name: "tim-continue",
  description: "Render the previous session's briefing on demand — its summary, its handoff note, and the turns no summary covers yet. Use when the user says /tim-continue, \"weitermachen wo wir waren\", \"what were we working on\", \"pick up where we left off\", or asks for the last session's state without naming a topic.",
  content: `# TIM Continue

The briefing that used to arrive automatically at session start, now asked for
deliberately. Same text, same source — the difference is that it appears when
the work actually continues, instead of in every session that happens to start
in this directory.

## Steps

1. **Get the project label.** The bound project, from the session-start
   directive or \`tim_load_project\`. If none is bound, bind first.
2. **Render:** Call \`tim_preview_briefing\` with that \`project\`.
3. **Use the \`── directive ──\` block as context.** It carries the previous
   session's summary, its handoff note, and the not-yet-summarized raw turns.
   - Do NOT paraphrase it back in full.
   - Confirm in one or two lines: where things stand and the next step.
4. **Continue the work.**

## Rules

- \`tim_preview_briefing\` is a pure read: no session, no marker, no hooks. The
  current session keeps its own identity and its exchanges keep appending to it.
- Do **not** use \`tim_session_resume\` for this. That tool aliases the running
  session onto the old session node — a session merge, not a briefing — and it
  throws once the current session has logged an exchange.
- No topic argument and no session picker: this is the previous session,
  verbatim. For anything older or subject-specific, use \`/tim-resume-topic\`.
- If the previous session left no handoff note, say so plainly rather than
  presenting its summary as a plan.
`,
};
