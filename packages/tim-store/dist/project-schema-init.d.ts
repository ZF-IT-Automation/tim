import { type ProjectSchema } from 'tim-core';
import type { TimStore } from './store.js';
/**
 * Spacing between sibling schema sections in metadata.order. Wide enough that a
 * user can slot a hand-made section between two schema sections without a
 * renumber, and low enough to stay below the session/commit roots (1000/1100).
 */
export declare const SCHEMA_ORDER_STEP = 10;
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
export declare function ensureProjectSchema(store: TimStore, projectRef: string, options?: EnsureProjectSchemaOptions): Promise<EnsureProjectSchemaResult>;
/** Read-only view of `ensureProjectSchema` — what a repair would add. */
export declare function planProjectSchema(store: TimStore, projectRef: string, options?: Omit<EnsureProjectSchemaOptions, 'dryRun'>): Promise<EnsureProjectSchemaResult>;
//# sourceMappingURL=project-schema-init.d.ts.map