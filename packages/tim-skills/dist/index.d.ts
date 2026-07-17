export { TIM_HANDOFF_SKILL } from './tim-handoff.js';
export { TIM_EXPLAIN_SKILL } from './tim-explain.js';
export { TIM_USING_SKILL } from './tim-using.js';
export { TIM_REMEMBER_SKILL } from './tim-remember.js';
export { TIM_SESSION_START_SKILL } from './tim-session-start.js';
export { TIM_HMEM_IMPORT_AUDIT_SKILL } from './tim-hmem-import-audit.js';
export { TIM_RELEASE_BETA_SKILL } from './tim-release-beta.js';
export { TIM_PROJECT_CURATE_SKILL } from './tim-project-curate.js';
export { TIM_SYNC_TRIAGE_SKILL } from './tim-sync-triage.js';
export { TIM_SECRET_AUDIT_SKILL } from './tim-secret-audit.js';
export { TIM_MCP_SMOKE_SKILL } from './tim-mcp-smoke.js';
export { TIM_NEW_PROJECT_SKILL } from './tim-new-project.js';
export interface TimSkill {
    name: string;
    description: string;
    content: string;
}
export declare const ALL_TIM_SKILLS: TimSkill[];
export declare function getSkill(name: string): TimSkill | undefined;
export declare function listSkills(): TimSkill[];
//# sourceMappingURL=index.d.ts.map