"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHARS_PER_TOKEN = void 0;
exports.charsToTokens = charsToTokens;
exports.estimateProjectTokens = estimateProjectTokens;
exports.listProjectTokenEstimates = listProjectTokenEstimates;
exports.CHARS_PER_TOKEN = 4;
function charsToTokens(chars) {
    return Math.round(chars / exports.CHARS_PER_TOKEN);
}
/**
 * Estimate briefing size for a project subtree (title + content chars).
 */
async function estimateProjectTokens(store, projectLabel, maxTokens) {
    const resolved = await store.resolveProjectLabel(projectLabel);
    if (resolved.status !== 'found')
        return null;
    const project = await store.read(resolved.label);
    if (!project)
        return null;
    const rows = store.getDb().prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM entries WHERE id = ?
      UNION ALL
      SELECT c.id FROM entries c
      INNER JOIN tree t ON c.parent_id = t.id
      WHERE c.tombstoned_at IS NULL
    )
    SELECT COALESCE(SUM(LENGTH(COALESCE(title, '')) + LENGTH(COALESCE(content, ''))), 0) AS chars
    FROM entries
    WHERE id IN (SELECT id FROM tree) AND irrelevant = 0
  `).get(project.id);
    const estChars = rows.chars;
    const estTokens = charsToTokens(estChars);
    return {
        label: resolved.label,
        title: project.title,
        estChars,
        estTokens,
        overBriefingBudget: estTokens > maxTokens,
    };
}
async function listProjectTokenEstimates(store, maxTokens) {
    const projects = await store.getByMetadataKind('project');
    const out = [];
    for (const p of projects) {
        const label = p.title.match(/^(P\d{4})/)?.[1] ?? p.id;
        const est = await estimateProjectTokens(store, label, maxTokens);
        if (est)
            out.push(est);
    }
    return out.sort((a, b) => b.estTokens - a.estTokens);
}
//# sourceMappingURL=token-budget.js.map