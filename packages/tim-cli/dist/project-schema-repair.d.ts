import { TimStore } from 'tim-store';
export interface ProjectSchemaFinding {
    label: string;
    title: string;
    /** Schema sections the project does not have yet (slash paths). */
    missing: string[];
    /** Section titles the project has that the schema does not describe — never touched. */
    unknown: string[];
}
export interface ProjectSchemaRepairOutcome {
    label: string;
    added: string[];
    error?: string;
}
/**
 * Read-only survey of every project against the standard schema.
 * `projectFilter` limits it to one label/alias.
 */
export declare function collectProjectSchemaReport(store: TimStore, projectFilter?: string): Promise<ProjectSchemaFinding[]>;
export declare function formatProjectSchemaFindingLine(finding: ProjectSchemaFinding): string;
export declare function formatProjectSchemaOutcomeLine(outcome: ProjectSchemaRepairOutcome): string;
/**
 * Additive repair: create the schema sections a project is missing. Nothing is
 * renamed, moved, or deleted — sections outside the schema stay exactly as they are.
 */
export declare function repairProjectSchemas(store: TimStore, findings: ProjectSchemaFinding[]): Promise<ProjectSchemaRepairOutcome[]>;
//# sourceMappingURL=project-schema-repair.d.ts.map