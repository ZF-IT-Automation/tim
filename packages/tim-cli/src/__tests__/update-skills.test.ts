import { describe, it, expect } from 'vitest';
import { resolveHostSkillsBase } from '../update-skills.js';

describe('update-skills host target paths', () => {
  it('uses os homedir when HOME is unavailable', () => {
    const originalHome = process.env.HOME;
    delete process.env.HOME;
    try {
      expect(resolveHostSkillsBase('claude')).toMatch(/\/\.claude\/skills$/);
      expect(resolveHostSkillsBase('claude')).not.toBe('.claude/skills');
      expect(resolveHostSkillsBase('codex')).toMatch(/\/\.codex\/skills$/);
      expect(resolveHostSkillsBase('hermes')).toMatch(/\/\.hermes\/skills$/);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
