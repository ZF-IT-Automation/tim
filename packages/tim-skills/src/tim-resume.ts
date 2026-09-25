export const TIM_RESUME_SKILL = {
  name: 'tim-resume',
  description: 'Resume previous work in this tool — the latest briefing, or a topic the user names. Use when the user says /tim-resume, "resume session", "Session fortsetzen", "weitermachen wo wir waren", or after hitting a session limit in another tool.',
  content: `# TIM Resume

Continue previous work. The default tool list has no session picker.

## Steps

1. **No topic named** ("the last one", "where we were"): call \`tim_preview_briefing\`
   with the bound project. If none is bound, \`tim_load_project\` first.
2. **Topic named:** call \`tim_resume_topic({ topic })\`.
3. **Present:** one or two lines — where things stand and the next step.
   Do not paste the payload back. If it contains ⚠ warnings, mention them in one line.
4. **Continue** the work from that state.

## Rules

- Both calls are pure reads. They do not merge this session onto an older one.
- For a subject older than the latest briefing, use \`/tim-resume-topic\`.
- If the briefing has no handoff note, say so. Do not treat the summary as a plan.
`,
};
