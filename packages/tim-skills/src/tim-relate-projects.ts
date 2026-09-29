export const TIM_RELATE_PROJECTS_SKILL = {
  name: 'tim-relate-projects',
  description: 'Link TIM projects so resume-topic and continue recall neighbour sessions; set descriptions for briefing lines.',
  content: `# tim-relate-projects

Use when work spans repositories that should recall each other's sessions (e.g. Game-Harness ↔ MAIMO).

## When to relate
- Same product line, different repos, and you want \`/tim-resume-topic\` in either project to find the other's tagged sessions.
- Not for casual name similarity — edges are intentional and symmetric.

## CLI (no MCP tool)
\`\`\`bash
tim project describe P00XX "One to three sentences: what this project IS."
tim project relate P00AA P00BB
tim project related P00AA
tim project unrelate P00AA P00BB
\`\`\`
- \`relate\` no-ops when already linked (either direction) or when A == B.
- \`unrelate\` drops the edge either way. Archived neighbours stay hidden in briefings.

## After relating
- \`tim_load_project\` and session-start directives list neighbours (label, name, optional description).
- \`/tim-resume-topic\` merges matching sessions across neighbours, tagged by project name.
- \`/tim-continue\` may show a neighbour's handoff only when that project's newest substantive session is newer than this one's.
`,
};
