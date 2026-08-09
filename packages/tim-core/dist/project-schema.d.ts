/**
 * The standard TIM project schema — the single source of truth for "what sections
 * a project has".
 *
 * It lives in tim-core (not in repo-root `docs/`, and not in tim-store or tim-mcp)
 * for two reasons:
 *   1. Shipping. Every package publishes only `dist/**`, so a JSON file under
 *      repo-root `docs/` reaches no installed package. A compiled module does.
 *   2. Dependency direction. The creation side (tim-store → tim-hooks → tim-cli)
 *      and the render side (tim-mcp) both sit above tim-core, so both can import
 *      this without a cycle.
 *
 * `docs/project-schema.json` is a generated mirror for humans — regenerate it with
 * `node scripts/sync-project-schema.mjs`; a test fails if the two drift apart.
 */
/** Entry types a collection section can stamp on its children. */
export type SectionEntryType = 'task' | 'bug' | 'idea';
export interface ProjectSchemaSection {
    name: string;
    description?: string;
    render_depth?: number | 'full';
    render_tail?: boolean;
    /**
     * Collection sections whose children are all the same kind of thing. A child
     * written here without its own classification gets `metadata.type` plus the
     * matching marker object (`task`/`bug`/`idea`) filled in with its default
     * status, so what an entry *is* stops depending on who wrote it.
     *
     * Only set where a renderer actually reads the type. Sections whose children
     * are individual prose (Log, Roadmap, Decisions, Codebase, Usage, Rules)
     * deliberately have none — stamping a type nobody reads is noise.
     */
    entry_type?: SectionEntryType;
    /**
     * Materialized on demand by a subsystem that owns its own metadata.kind
     * (Sessions → sessions-root, Commits → commits-root). `ensureProjectSchema`
     * must not pre-create these: those subsystems look their node up by kind, not
     * by title, so a plain kind=section placeholder would leave two siblings with
     * the same name.
     */
    managed?: boolean;
    children?: ProjectSchemaSection[];
}
export interface ProjectSchema {
    version?: number;
    description?: string;
    sections: ProjectSchemaSection[];
    /** Prose documentation blocks (render legend, task/idea annotations). */
    [key: string]: unknown;
}
export declare const PROJECT_SCHEMA: ProjectSchema;
/** Depth-first lookup of a schema section by exact name (matches nested children). */
export declare function findSchemaSection(sections: ProjectSchemaSection[] | undefined, name: string): ProjectSchemaSection | undefined;
/** Every section name in the schema, including nested children. */
export declare function schemaSectionNames(sections?: ProjectSchemaSection[]): string[];
//# sourceMappingURL=project-schema.d.ts.map