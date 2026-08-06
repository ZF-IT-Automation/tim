"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectProjectSchemaReport = collectProjectSchemaReport;
exports.formatProjectSchemaFindingLine = formatProjectSchemaFindingLine;
exports.formatProjectSchemaOutcomeLine = formatProjectSchemaOutcomeLine;
exports.repairProjectSchemas = repairProjectSchemas;
const tim_store_1 = require("tim-store");
/**
 * Read-only survey of every project against the standard schema.
 * `projectFilter` limits it to one label/alias.
 */
async function collectProjectSchemaReport(store, projectFilter) {
    const projects = await store.listProjects();
    const findings = [];
    for (const project of projects) {
        if (projectFilter && project.label !== projectFilter)
            continue;
        try {
            const plan = await (0, tim_store_1.planProjectSchema)(store, project.id);
            findings.push({
                label: project.label,
                title: project.title,
                missing: plan.created,
                unknown: plan.unknown,
            });
        }
        catch {
            // A project that cannot be resolved (tombstoned mid-scan, ambiguous alias)
            // is not a schema problem — skip it rather than failing the whole report.
        }
    }
    return findings;
}
function formatProjectSchemaFindingLine(finding) {
    const parts = [];
    parts.push(finding.missing.length === 0
        ? '✓ complete'
        : `${finding.missing.length} missing: ${finding.missing.join(', ')}`);
    if (finding.unknown.length > 0) {
        parts.push(`custom (kept): ${finding.unknown.join(', ')}`);
    }
    return `  ${finding.label} ${finding.title} — ${parts.join(' | ')}`;
}
function formatProjectSchemaOutcomeLine(outcome) {
    if (outcome.error)
        return `  ✗ ${outcome.label}: ${outcome.error}`;
    if (outcome.added.length === 0)
        return `  ⊘ ${outcome.label}: already complete`;
    return `  ✓ ${outcome.label}: added ${outcome.added.join(', ')}`;
}
/**
 * Additive repair: create the schema sections a project is missing. Nothing is
 * renamed, moved, or deleted — sections outside the schema stay exactly as they are.
 */
async function repairProjectSchemas(store, findings) {
    const outcomes = [];
    for (const finding of findings) {
        if (finding.missing.length === 0)
            continue;
        try {
            const result = await (0, tim_store_1.ensureProjectSchema)(store, finding.label);
            outcomes.push({ label: finding.label, added: result.created });
        }
        catch (err) {
            outcomes.push({
                label: finding.label,
                added: [],
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return outcomes;
}
//# sourceMappingURL=project-schema-repair.js.map