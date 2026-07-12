---
name: tim-resume
description: Resume a previous TIM session in this tool — list recent sessions of the bound project, let the user pick one, then load its context (summary + batch summaries + last raw exchanges) and continue appending to it. Use when the user says /tim-resume, "resume session", "Session fortsetzen", "weitermachen wo wir waren", or after hitting a session limit in another tool.
---

# TIM Resume

Continue a previous session — possibly started in a different tool — as if it never stopped.

## Steps

1. **List:** Call `tim_resume_list` (no args — uses the bound project).
   - If it responds with project-binding guidance, follow that first, then retry.
2. **Present:** Show the numbered list to the user (date, tool, task, summary line).
   Ask which session to resume. Do NOT auto-pick — unless the user already named
   a specific session or said "the last one" (then pick entry 1).
3. **Resume:** Call `tim_session_resume` with the chosen `sessionId`.
4. **Continue:** Treat the returned block as restored conversation context:
   - Do NOT paraphrase the whole payload back to the user.
   - Confirm in one line: "Resumed session from <date> — last state: <one-line gist>".
   - If the payload contains ⚠ warnings, mention them in one line.
   - Then continue the work from where the last exchanges left off.

## Rules

- All further exchanges append to the resumed session automatically (alias binding) —
  do not call `tim_session_start` afterwards.
- Resuming the current session after /clear is fine — same flow.
- If `tim_session_resume` errors with "legacy format", tell the user this session
  predates the resume feature and cannot be continued; offer to read its summary
  via `tim_read` instead.
