export interface UpdateSkillsResult {
    copied: {
        skill: string;
        target: string;
    }[];
    skipped: string[];
}
export declare function updateSkillsForHost(host: 'claude' | 'codex' | 'cursor' | 'hermes'): UpdateSkillsResult;
export declare function updateSkills(): UpdateSkillsResult;
//# sourceMappingURL=update-skills.d.ts.map