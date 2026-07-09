export interface UpdateSkillsResult {
    copied: {
        skill: string;
        target: string;
    }[];
    skipped: string[];
}
export type SkillsHost = 'claude' | 'codex' | 'cursor' | 'hermes';
export declare function resolveHostSkillsBase(host: SkillsHost): string | null;
export declare function updateSkillsForHost(host: SkillsHost): UpdateSkillsResult;
export declare function updateSkills(): UpdateSkillsResult;
//# sourceMappingURL=update-skills.d.ts.map