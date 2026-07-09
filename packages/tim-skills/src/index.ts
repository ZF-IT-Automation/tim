import { TIM_HANDOFF_SKILL } from './tim-handoff.js';
import { TIM_EXPLAIN_SKILL } from './tim-explain.js';
import { TIM_USING_SKILL } from './tim-using.js';
import { TIM_REMEMBER_SKILL } from './tim-remember.js';
import { TIM_SESSION_START_SKILL } from './tim-session-start.js';
import { TIM_HMEM_IMPORT_AUDIT_SKILL } from './tim-hmem-import-audit.js';
import { TIM_RELEASE_BETA_SKILL } from './tim-release-beta.js';
import { TIM_PROJECT_CURATE_SKILL } from './tim-project-curate.js';
import { TIM_SYNC_TRIAGE_SKILL } from './tim-sync-triage.js';
import { TIM_SECRET_AUDIT_SKILL } from './tim-secret-audit.js';
import { TIM_MCP_SMOKE_SKILL } from './tim-mcp-smoke.js';

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
  TIM_HMEM_IMPORT_AUDIT_SKILL,
  TIM_RELEASE_BETA_SKILL,
  TIM_PROJECT_CURATE_SKILL,
  TIM_SYNC_TRIAGE_SKILL,
  TIM_SECRET_AUDIT_SKILL,
  TIM_MCP_SMOKE_SKILL,
];

export function getSkill(name: string): TimSkill | undefined {
  return ALL_TIM_SKILLS.find(s => s.name === name);
}

export function listSkills(): TimSkill[] {
  return [...ALL_TIM_SKILLS];
}
