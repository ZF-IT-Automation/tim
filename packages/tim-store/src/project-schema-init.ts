import type { Entry } from 'tim-core';
import { PROJECT_SCHEMA, type ProjectSchema, type ProjectSchemaSection } from 'tim-core';
import type { TimStore } from './store.js';

/**
 * Spacing between sibling schema sections in metadata.order. Wide enough that a
 * user can slot a hand-made section between two schema sections without a
 * renumber, and low enough to stay below the session/commit roots (1000/1100).
 */
export const SCHEMA_ORDER_STEP = 10;

export interface EnsureProjectSchemaOptions {
  /** Override the schema (tests / future per-project schemas). Defaults to PROJECT_SCHEMA. */
  schema?: ProjectSchema;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

export interface EnsureProjectSchemaResult {
  projectId: string;
  /** Slash paths of sections created (or, in dryRun, that would be created). */
  created: string[];
  /** Slash paths of schema sections that were already present. */
  existing: string[];
  /**
   * Titles of live sections under the project root that the schema does not know
   * about ("Errors", "Learnings", "Testing", …). Reported so a caller can show
   * them; never renamed, moved, or deleted.
   */
  unknown: string[];
}

/** Live direct children of `parentId`, keyed by title. */
async function childrenByTitle(store: TimStore, parentId: string): Promise<Map<string, Entry>> {
  const children = await store.getChildren(parentId);
  const byTitle = new Map<string, Entry>();
  for (const child of children) {
    // First writer wins: a duplicate title is left alone rather than reconciled.
    if (!byTitle.has(child.title)) byTitle.set(child.title, child);
  }
  return byTitle;
}

function sectionMetadata(section: ProjectSchemaSection, index: number): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    kind: 'section',
    label: section.name,
    order: index * SCHEMA_ORDER_STEP,
  };
  // Carry the schema's render hints onto the node so the renderer resolves them
  // from metadata even when it cannot reach the schema (resolveRenderDepth reads
  // metadata.render_depth before falling back to the schema, then to 1).
  if (section.render_depth !== undefined) metadata.render_depth = section.render_depth;
  if (section.render_tail !== undefined) metadata.render_tail = section.render_tail;
  return metadata;
}

/**
 * Materialize `sections` under `parentId`, recursing into children.
 * `parentId === null` means the parent itself does not exist yet (dryRun only) —
 * everything below is reported as "would be created".
 */
async function materializeLevel(
  store: TimStore,
  parentId: string | null,
  sections: ProjectSchemaSection[],
  prefix: string,
  dryRun: boolean,
  result: EnsureProjectSchemaResult,
): Promise<void> {
  const existingChildren = parentId ? await childrenByTitle(store, parentId) : new Map<string, Entry>();

  for (let index = 0; index < sections.length; index++) {
    const section = sections[index]!;
    const sectionPath = prefix ? `${prefix}/${section.name}` : section.name;

    // Sessions/Commits are owned by the session and commit trees, which look their
    // root up by metadata.kind. Creating a kind=section twin here would give the
    // project two nodes named "Sessions".
    if (section.managed) continue;

    let node = existingChildren.get(section.name) ?? null;
    if (node) {
      result.existing.push(sectionPath);
    } else {
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
      await materializeLevel(
        store,
        node?.id ?? null,
        section.children,
        sectionPath,
        dryRun,
        result,
      );
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
export async function ensureProjectSchema(
  store: TimStore,
  projectRef: string,
  options: EnsureProjectSchemaOptions = {},
): Promise<EnsureProjectSchemaResult> {
  const schema = options.schema ?? PROJECT_SCHEMA;
  const dryRun = options.dryRun === true;

  // projectRef may be a raw entry id (creation paths) or a label/alias (CLI).
  const direct = await store.read(projectRef);
  const project = direct?.metadata.kind === 'project'
    ? direct
    : await store.requireProject(projectRef);

  const result: EnsureProjectSchemaResult = {
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
    if (entry.metadata.kind !== 'section') continue;
    if (!schemaTopLevel.has(title)) result.unknown.push(title);
  }

  return result;
}

/** Read-only view of `ensureProjectSchema` — what a repair would add. */
export async function planProjectSchema(
  store: TimStore,
  projectRef: string,
  options: Omit<EnsureProjectSchemaOptions, 'dryRun'> = {},
): Promise<EnsureProjectSchemaResult> {
  return ensureProjectSchema(store, projectRef, { ...options, dryRun: true });
}
