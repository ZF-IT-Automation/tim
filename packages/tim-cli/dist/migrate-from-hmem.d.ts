import { TimStore } from 'tim-store';
import { type ProjectBindingFinding } from 'tim-hooks';
export interface HmemWizardStep {
    id: string;
    description: string;
}
export interface MigrateFromHmemOptions {
    deduplicate?: boolean;
}
export declare function buildMigrateFromHmemPlan(source: string, opts?: MigrateFromHmemOptions): HmemWizardStep[];
export declare function evaluateDryRunGate(report: {
    format: string;
    warnings: string[];
}): string[];
export declare function buildImportAuditArgs(source: string): {
    source: string;
    includeRepairPlan: true;
};
/** Labels for project roots imported from hmem (metadata.hmemUid present). */
export declare function listHmemImportedProjectLabels(store: TimStore): Promise<string[]>;
/** Binding findings for hmem-imported projects only — reuses doctor classification. */
export declare function collectMigrationProjectBindings(store: TimStore): Promise<ProjectBindingFinding[]>;
export declare function formatMigrationBindingLines(findings: ProjectBindingFinding[]): string[];
export declare function cmdMigrateFromHmem(args: string[]): Promise<void>;
//# sourceMappingURL=migrate-from-hmem.d.ts.map