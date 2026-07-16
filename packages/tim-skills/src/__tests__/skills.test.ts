import { describe, it, expect } from 'vitest';
import {
  TIM_USING_SKILL,
  TIM_REMEMBER_SKILL,
  TIM_SESSION_START_SKILL,
  TIM_HANDOFF_SKILL,
  TIM_HMEM_IMPORT_AUDIT_SKILL,
  TIM_RELEASE_BETA_SKILL,
  TIM_PROJECT_CURATE_SKILL,
  TIM_SYNC_TRIAGE_SKILL,
  TIM_SECRET_AUDIT_SKILL,
  TIM_MCP_SMOKE_SKILL,
  getSkill,
  listSkills,
} from '../index.js';

function lineCount(text: string): number {
  return text.split('\n').length;
}

describe('weak-model skills', () => {
  it('tim-using has decision table and write example', () => {
    expect(TIM_USING_SKILL.content).toContain('tim_write');
    expect(TIM_USING_SKILL.content).toContain('tim_read');
    expect(TIM_USING_SKILL.content).toContain('tim_search');
    expect(lineCount(TIM_USING_SKILL.content)).toBeLessThanOrEqual(50);
  });

  it('tim-remember contrasts remember vs search vs read', () => {
    expect(TIM_REMEMBER_SKILL.content).toContain('tim_remember');
    expect(TIM_REMEMBER_SKILL.content).toContain('tim_search');
    expect(TIM_REMEMBER_SKILL.content).toContain('tim_read');
    expect(TIM_REMEMBER_SKILL.content).toContain('tim_guard');
    expect(lineCount(TIM_REMEMBER_SKILL.content)).toBeLessThanOrEqual(50);
  });

  it('tim-session-start covers lifecycle steps without model-driven exchange logging', () => {
    expect(TIM_SESSION_START_SKILL.content).toContain('tim_session_start');
    expect(TIM_SESSION_START_SKILL.content).toContain('tim_load_project');
    expect(TIM_SESSION_START_SKILL.content).not.toContain('tim_session_log');
    expect(TIM_SESSION_START_SKILL.content).toMatch(/hooks log exchanges automatically/i);
    expect(lineCount(TIM_SESSION_START_SKILL.content)).toBeLessThanOrEqual(50);
  });

  it('tim-handoff describes checkpoint handoff flow', () => {
    expect(TIM_HANDOFF_SKILL.content).toContain('handoff');
    expect(TIM_HANDOFF_SKILL.content).toContain('checkpoint');
    expect(lineCount(TIM_HANDOFF_SKILL.content)).toBeLessThanOrEqual(50);
  });

  it('tim-hmem-import-audit gives agents a post-import structure checklist', () => {
    expect(TIM_HMEM_IMPORT_AUDIT_SKILL.content).toContain('tim_import');
    expect(TIM_HMEM_IMPORT_AUDIT_SKILL.content).toContain('tim_load_project');
    expect(TIM_HMEM_IMPORT_AUDIT_SKILL.content).toContain('tim_read');
    expect(TIM_HMEM_IMPORT_AUDIT_SKILL.content).toContain('tim_update');
    expect(TIM_HMEM_IMPORT_AUDIT_SKILL.content).toContain('direct SQL');
    expect(TIM_HMEM_IMPORT_AUDIT_SKILL.content).toContain('Handoff');
    expect(lineCount(TIM_HMEM_IMPORT_AUDIT_SKILL.content)).toBeLessThanOrEqual(50);
  });

  it('tim-hmem-import-audit is discoverable via getSkill', () => {
    expect(getSkill('tim-hmem-import-audit')?.name).toBe('tim-hmem-import-audit');
  });

  it('migration and beta ops skills are concise and tool-oriented', () => {
    const expectations = [
      [TIM_RELEASE_BETA_SKILL, ['npm pack --dry-run', 'git tag', 'tim snapshot']],
      [TIM_PROJECT_CURATE_SKILL, ['tim_project_structure', 'tim_repair_section', 'tim_move_entry']],
      [TIM_SYNC_TRIAGE_SKILL, ['tim sync status', 'tim_sync', 'TIM_SYNC_PASSPHRASE']],
      [TIM_SECRET_AUDIT_SKILL, ['metadata.secret', 'tim_secret', 'tim_export']],
      [TIM_MCP_SMOKE_SKILL, ['tools/list', 'tim_doctor', 'tim_write']],
    ] as const;

    for (const [skill, needles] of expectations) {
      for (const needle of needles) expect(skill.content).toContain(needle);
      expect(lineCount(skill.content)).toBeLessThanOrEqual(50);
      expect(getSkill(skill.name)?.name).toBe(skill.name);
    }
  });

  it('listSkills returns all eleven skills', () => {
    expect(listSkills().map(s => s.name)).toEqual([
      'tim-handoff',
      'tim-explain',
      'tim-using',
      'tim-remember',
      'tim-session-start',
      'tim-hmem-import-audit',
      'tim-release-beta',
      'tim-project-curate',
      'tim-sync-triage',
      'tim-secret-audit',
      'tim-mcp-smoke',
    ]);
  });
});
