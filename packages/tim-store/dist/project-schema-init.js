"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMA_ORDER_STEP = void 0;
exports.ensureProjectSchema = ensureProjectSchema;
exports.planProjectSchema = planProjectSchema;
const tim_core_1 = require("tim-core");
/**
 * Spacing between sibling schema sections in metadata.order. Wide enough that a
 * user can slot a hand-made section between two schema sections without a
 * renumber, and low enough to stay below the session/commit roots (1000/1100).
 */
exports.SCHEMA_ORDER_STEP = 10;
/** Live direct children of `parentId`, keyed by title. */
async function childrenByTitle(store, parentId) {
    const children = await store.getChildren(parentId);
    const byTitle = new Map();
    for (const child of children) {
        // First writer wins: a duplicate title is left alone rather than reconciled.
        if (!byTitle.has(child.title))
            byTitle.set(child.title, child);
    }
    return byTitle;
}
function sectionMetadata(section, index) {
    const metadata = {
        kind: 'section',
        label: section.name,
        order: index * exports.SCHEMA_ORDER_STEP,
    };
    // Carry the schema's render hints onto the node so the renderer resolves them
    // from metadata even when it cannot reach the schema (resolveRenderDepth reads
    // metadata.render_depth before falling back to the schema, then to 1).
    if (section.render_depth !== undefined)
        metadata.render_depth = section.render_depth;
    if (section.render_tail !== undefined)
        metadata.render_tail = section.render_tail;
    return metadata;
}
/**
 * Materialize `sections` under `parentId`, recursing into children.
 * `parentId === null` means the parent itself does not exist yet (dryRun only) —
 * everything below is reported as "would be created".
 */
async function materializeLevel(store, parentId, sections, prefix, dryRun, result) {
    const existingChildren = parentId ? await childrenByTitle(store, parentId) : new Map();
    for (let index = 0; index < sections.length; index++) {
        const section = sections[index];
        const sectionPath = prefix ? `${prefix}/${section.name}` : section.name;
        // Sessions/Commits are owned by the session and commit trees, which look their
        // root up by metadata.kind. Creating a kind=section twin here would give the
        // project two nodes named "Sessions".
        if (section.managed)
            continue;
        let node = existingChildren.get(section.name) ?? null;
        if (node) {
            result.existing.push(sectionPath);
        }
        else {
            result.created.push(sectionPath);
            if (!dryRun && parentId) {
                node = await store.write(section.description ?? section.name, {
                    parentId,
                    title: section.name,
                    metadata: sectionMetadata(section, index),
                });
            }
        }
        if (section.children?.length) {
            await materializeLevel(store, node?.id ?? null, section.children, sectionPath, dryRun, result);
        }
    }
}
/**
 * Ensure every section of the standard project schema exists under `projectRef`
 * (a project id, label, or alias), including nested children, carrying each
 * section's render_depth / render_tail onto the created node's metadata.
 *
 * Idempotent: a section is created only when no live direct child of the same
 * title exists, so re-running adds nothing. Purely additive — sections the schema
 * does not describe are reported in `unknown` and otherwise left untouched, which
 * makes this safe to run as a migration over projects created with the older,
 * divergent section lists.
 */
async function ensureProjectSchema(store, projectRef, options = {}) {
    const schema = options.schema ?? tim_core_1.PROJECT_SCHEMA;
    const dryRun = options.dryRun === true;
    // projectRef may be a raw entry id (creation paths) or a label/alias (CLI).
    const direct = await store.read(projectRef);
    const project = direct?.metadata.kind === 'project'
        ? direct
        : await store.requireProject(projectRef);
    const result = {
        projectId: project.id,
        created: [],
        existing: [],
        unknown: [],
    };
    const before = await childrenByTitle(store, project.id);
    await materializeLevel(store, project.id, schema.sections, '', dryRun, result);
    const schemaTopLevel = new Set(schema.sections.map(s => s.name));
    for (const [title, entry] of before) {
        // Only structural sections count as "unknown" — session/commit roots and
        // loose notes written directly under the project root are not schema drift.
        if (entry.metadata.kind !== 'section')
            continue;
        if (!schemaTopLevel.has(title))
            result.unknown.push(title);
    }
    return result;
}
/** Read-only view of `ensureProjectSchema` — what a repair would add. */
async function planProjectSchema(store, projectRef, options = {}) {
    return ensureProjectSchema(store, projectRef, { ...options, dryRun: true });
}
//# sourceMappingURL=project-schema-init.js.map