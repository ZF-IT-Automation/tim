export { TIM_HANDOFF_SKILL } from './tim-handoff.js';
export { TIM_EXPLAIN_SKILL } from './tim-explain.js';
export { TIM_USING_SKILL } from './tim-using.js';
export { TIM_REMEMBER_SKILL } from './tim-remember.js';
export { TIM_SESSION_START_SKILL } from './tim-session-start.js';
export interface TimSkill {
    name: string;
    description: string;
    content: string;
}
export declare const ALL_TIM_SKILLS: TimSkill[];
export declare function getSkill(name: string): TimSkill | undefined;
export declare function listSkills(): TimSkill[];
//# sourceMappingURL=index.d.ts.map