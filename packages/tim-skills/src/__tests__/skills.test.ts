import { describe, it, expect } from 'vitest';
import {
  TIM_USING_SKILL,
  TIM_REMEMBER_SKILL,
  TIM_SESSION_START_SKILL,
  TIM_HANDOFF_SKILL,
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

  it('tim-session-start covers lifecycle steps', () => {
    expect(TIM_SESSION_START_SKILL.content).toContain('tim_session_start');
    expect(TIM_SESSION_START_SKILL.content).toContain('tim_load_project');
    expect(TIM_SESSION_START_SKILL.content).toContain('tim_session_log');
    expect(lineCount(TIM_SESSION_START_SKILL.content)).toBeLessThanOrEqual(50);
  });

  it('tim-handoff describes checkpoint handoff flow', () => {
    expect(TIM_HANDOFF_SKILL.content).toContain('handoff');
    expect(TIM_HANDOFF_SKILL.content).toContain('checkpoint');
    expect(lineCount(TIM_HANDOFF_SKILL.content)).toBeLessThanOrEqual(50);
  });

  it('listSkills returns all five skills', () => {
    expect(listSkills().map(s => s.name)).toEqual([
      'tim-handoff',
      'tim-explain',
      'tim-using',
      'tim-remember',
      'tim-session-start',
    ]);
  });
});
