"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIM_REMEMBER_SKILL = void 0;
exports.TIM_REMEMBER_SKILL = {
    name: 'tim-remember',
    description: 'remember vs search vs read — when to use which.',
    content: `# tim-remember

| Situation | Tool | Why |
|-----------|------|-----|
| Know exact id/label | \`tim_read\` | Direct hit, no ranking noise |
| Know keywords | \`tim_search\` | FTS5, fast, precise terms |
| Vague / "we discussed X last week" | \`tim_remember\` | Expands variants + reranks |

Examples:
- "What's in P0063 Tasks?" → \`tim_read({ id: "P0063/Tasks" })\` or \`tim_show({ what: "tasks", root: "P0063" })\`
- "Find entries about sync passphrase" → \`tim_search({ query: "sync passphrase" })\`
- "Remember when rmapi failed?" → \`tim_remember({ query: "rmapi upload failed" })\`

Before risky action → \`tim_guard({ action: "upload PDF via rmapi" })\` (negative memory check).
`,
};
//# sourceMappingURL=tim-remember.js.map