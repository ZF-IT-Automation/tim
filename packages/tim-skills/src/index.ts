import { TIM_HANDOFF_SKILL } from './tim-handoff.js';
import { TIM_EXPLAIN_SKILL } from './tim-explain.js';
import { TIM_USING_SKILL } from './tim-using.js';
import { TIM_REMEMBER_SKILL } from './tim-remember.js';
import { TIM_SESSION_START_SKILL } from './tim-session-start.js';

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

export const ALL_TIM_SKILLS: TimSkill[] = [
  TIM_HANDOFF_SKILL,
  TIM_EXPLAIN_SKILL,
  TIM_USING_SKILL,
  TIM_REMEMBER_SKILL,
  TIM_SESSION_START_SKILL,
];

export function getSkill(name: string): TimSkill | undefined {
  return ALL_TIM_SKILLS.find(s => s.name === name);
}

export function listSkills(): TimSkill[] {
  return [...ALL_TIM_SKILLS];
}
