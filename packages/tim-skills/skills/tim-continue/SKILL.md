---
name: tim-continue
description: Brief the human on where this project's work stands — the previous session's summary, handoff note and not-yet-summarized turns — then wait for direction. Use when the user says /tim-continue, "weitermachen wo wir waren", "what were we working on", "pick up where we left off", or asks for the last session's state without naming a topic.
---

# TIM Continue

Loads the previous session's state and hands it to the human. What happens
next is their call.

## Steps

1. **Bind.** Use the bound project label, from the session-start directive or
   `tim_load_project`. If none is bound, bind first.
2. **Render.** Call `tim_preview_briefing` with that `project`. It is a pure
   read: the running session keeps its identity and keeps logging to itself.
3. **Brief the human** from the `── directive ──` block, short and structured:
   - where the work stands (2–4 bullets)
   - the handoff note's next step, or plainly "no handoff note" when there is
     none
   - what is still open
   - when `## Meanwhile in related projects` is present: one line on what the
     neighbours did. It is background; this project's handoff stays the only
     next step.
4. **Ask how to proceed, then end the turn.** Ask in plain text. The handoff
   note is a proposal until the human confirms it, so the turn ends at the
   question — before any file read, edit, test or tool call.

## Reference

- **Which session:** the newest *substantive* one (≥ 3 turns, a handoff note,
  or judged real by the summarizer; worker and automation sessions never
  count), plus this project's newest handoff note from another session when it
  sits elsewhere. Older or subject-specific work → `/tim-resume-topic`.
- **Briefing, not merge:** the running session stays its own node. Merging it
  onto the old session node is a different operation, and it fails once this
  session has logged an exchange.
