export interface HmemWizardStep {
    id: string;
    description: string;
}
export interface MigrateFromHmemOptions {
    deduplicate?: boolean;
}
export declare function buildMigrateFromHmemPlan(source: string, opts?: MigrateFromHmemOptions): HmemWizardStep[];
export declare function cmdMigrateFromHmem(args: string[]): Promise<void>;
//# sourceMappingURL=migrate-from-hmem.d.ts.map