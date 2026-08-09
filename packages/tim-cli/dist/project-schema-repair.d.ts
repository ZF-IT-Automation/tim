import { TimStore } from 'tim-store';
export interface ProjectSchemaFinding {
    label: string;
    title: string;
    /** Schema sections the project does not have yet (slash paths). */
    missing: string[];
    /** Section titles the project has that the schema does not describe — never touched. */
    unknown: string[];
    /** Legacy sections titled with their own description, as `old → new`. */
    renamed: string[];
}
export interface ProjectSchemaRepairOutcome {
    label: string;
    added: string[];
    renamed: string[];
    error?: string;
}
/**
 * Read-only survey of every project against the standard schema.
 * `projectFilter` limits it to one label/alias.
 */
export declare function collectProjectSchemaReport(store: TimStore, projectFilter?: string): Promise<ProjectSchemaFinding[]>;
export declare function formatProjectSchemaFindingLine(finding: ProjectSchemaFinding): string;
/** A project needs repair when sections are missing OR mistitled. */
export declare function needsSchemaRepair(finding: ProjectSchemaFinding): boolean;
export declare function formatProjectSchemaOutcomeLine(outcome: ProjectSchemaRepairOutcome): string;
/**
 * Repair a project against the schema: create the sections it lacks, and retitle
 * legacy sections that carry a schema label under their own description (see
 * ensureProjectSchema — the alternative would strand their content behind a
 * correctly-titled twin). Nothing is moved or deleted, and sections outside the
 * schema stay exactly as they are.
 */
export declare function repairProjectSchemas(store: TimStore, findings: ProjectSchemaFinding[]): Promise<ProjectSchemaRepairOutcome[]>;
//# sourceMappingURL=project-schema-repair.d.ts.map