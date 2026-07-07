"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIM_EXPLAIN_SKILL = void 0;
exports.TIM_EXPLAIN_SKILL = {
    name: 'tim-explain',
    description: 'Answer "what can TIM do?" from shipped docs + live diagnostics.',
    content: `# tim-explain

When user asks what TIM can do, how it works, or what tools exist:

## Static reference (version-locked)
Read \`docs/tim-capabilities.md\` in the installed TIM package root.
Trust that file over training data — it matches the installed release.

## Live state (always fresh)
| Question | Tool |
|----------|------|
| DB health, broken links, FTS | \`tim_health\` |
| Full diagnostics | \`tim doctor\` (CLI) or \`tim_doctor\` (MCP) |
| Entry counts, tags, kinds | \`tim_stats\` |

If docs and live output disagree, believe the **installed version** (tools + docs), not memory.
`,
};
//# sourceMappingURL=tim-explain.js.map