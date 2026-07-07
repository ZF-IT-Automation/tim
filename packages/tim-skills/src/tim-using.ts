export const TIM_USING_SKILL = {
  name: 'tim-using',
  description: 'When to write, read, or search TIM — one example each.',
  content: `# tim-using

| Goal | Tool | Example |
|------|------|---------|
| Save new fact/task/idea | \`tim_write\` | \`tim_write({ where: "P0063/Ideas", title: "Cache layer", content: "...", tags: ["#tim"] })\` |
| Known label/id, need body | \`tim_read\` | \`tim_read({ id: "P0063" })\` or \`tim_read({ id: "L0042", depth: 2 })\` |
| Keyword lookup | \`tim_search\` | \`tim_search({ query: "sqlite WAL", topK: 10 })\` |

Rules:
- \`tim_write\` = create only. Edit → \`tim_update\` (read first, merge, then update).
- \`duplicate_suspected\` → read candidate, extend via \`tim_update\`, don't \`force:true\` blindly.
- Topic tags only (#tim). Status/priority → \`metadata.task\`.
`,
};
