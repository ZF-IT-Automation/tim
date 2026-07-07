import { describe, it, expect } from 'vitest';
import { TIM_EXPLAIN_SKILL, getSkill } from '../index.js';

describe('tim-explain skill', () => {
  it('loads with capabilities doc path and live-state tools', () => {
    expect(TIM_EXPLAIN_SKILL.name).toBe('tim-explain');
    expect(TIM_EXPLAIN_SKILL.content).toContain('tim-capabilities.md');
    expect(TIM_EXPLAIN_SKILL.content).toContain('tim_health');
    expect(TIM_EXPLAIN_SKILL.content).toContain('tim_doctor');
    expect(TIM_EXPLAIN_SKILL.content).toContain('tim_stats');
    expect(TIM_EXPLAIN_SKILL.content.split('\n').length).toBeLessThanOrEqual(50);
  });

  it('is discoverable via getSkill', () => {
    expect(getSkill('tim-explain')?.name).toBe('tim-explain');
  });
});
