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
tim project related                       # neighbours of this directory's project
tim project relate game-harness           # this project ↔ Game Harness
tim project relate MAIMO "game harness"   # any two projects
tim project describe "One to three sentences: what this project IS."
tim project unrelate game-harness
\`\`\`
- Name projects by label (P0054), alias or name — case, \`-\`, \`_\` and spaces don't matter. No label lookup needed first.
- An omitted first project is the one this directory is bound to (\`.tim-project\`).
- No match or several matches → the CLI lists the candidates with label + name; pick one and rerun.
- Output always shows label + name: \`Related P0054 MAIMO-RPG ↔ P0076 Game Harness\`.
- \`relate\` no-ops when already linked (either direction) or when A == B. \`unrelate\` drops the edge either way.
- Archived neighbours stay hidden in briefings.

## After relating
- \`tim_load_project\` and session-start directives list neighbours (label, name, optional description).
- \`/tim-resume-topic\` merges matching sessions across neighbours, tagged by project name.
- \`/tim-continue\` may show a neighbour's handoff only when that project's newest substantive session is newer than this one's.
`,
};
