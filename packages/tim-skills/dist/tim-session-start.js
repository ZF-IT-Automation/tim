"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIM_SESSION_START_SKILL = void 0;
exports.TIM_SESSION_START_SKILL = {
    name: 'tim-session-start',
    description: 'TIM session lifecycle — start, bind project, log exchanges.',
    content: `# tim-session-start

## Session lifecycle
1. **Start** — \`tim_session_start({ sessionId, projectId?, cwd, harness, agentName })\`
   Returns session node; binds project when \`projectId\` or cwd \`.tim-project\` present.
2. **Load brief** — \`tim_load_project({ label: "P0063", bind: true, sessionId })\`
   One bind per session. Cross-project read → \`bind: false\`.
3. **Log turns** — \`tim_session_log({ sessionId, entries: [{ role: "user", content: "..." }, { role: "agent", content: "..." }] })\`
4. **End** — \`tim_checkpoint({ sessionId })\` or harness session-end hook.

## Hooks (automatic)
- SessionStart briefing may include delta + update line (no extra calls).
- UserPromptSubmit injects retrieval context via \`tim_hook_prompt_submit\`.

## Inbox fallback (P0000)
If no project bound, response includes ACTION to \`tim_load_project\` a real project.
`,
};
//# sourceMappingURL=tim-session-start.js.map