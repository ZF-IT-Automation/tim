import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { copySkillsTo, resolveHostSkillsBase, updateSkills } from '../update-skills.js';

describe('update-skills host target paths', () => {
  it('uses os homedir when HOME is unavailable', () => {
    const originalHome = process.env.HOME;
    delete process.env.HOME;
    try {
      expect(resolveHostSkillsBase('claude')).toMatch(/\/\.claude\/skills$/);
      expect(resolveHostSkillsBase('claude')).not.toBe('.claude/skills');
      expect(resolveHostSkillsBase('codex')).toMatch(/\/\.codex\/skills$/);
      expect(resolveHostSkillsBase('hermes')).toMatch(/\/\.hermes\/skills$/);
      expect(resolveHostSkillsBase('cursor')).toMatch(/\/\.cursor\/skills$/);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('copies into the target of a symlinked skill dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-skills-'));
    const src = path.join(root, 'src', 'tim-x');
    const shared = path.join(root, 'shared', 'tim-x');
    const host = path.join(root, 'host');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(host);
    fs.writeFileSync(path.join(src, 'SKILL.md'), 'new');
    fs.writeFileSync(path.join(shared, 'SKILL.md'), 'old');
    fs.symlinkSync(shared, path.join(host, 'tim-x'));

    copySkillsTo(path.join(root, 'src'), host);

    expect(fs.lstatSync(path.join(host, 'tim-x')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(shared, 'SKILL.md'), 'utf8')).toBe('new');
  });

  it('updates every installed host and skips the missing ones', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-home-'));
    const env = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    try {
      const installed = ['.claude', '.codex', '.cursor', '.gemini', '.config/opencode'];
      for (const dir of installed) fs.mkdirSync(path.join(home, dir), { recursive: true });
      updateSkills();
      for (const dir of installed) {
        expect(fs.existsSync(path.join(home, dir, 'skills', 'tim-relate-projects', 'SKILL.md'))).toBe(true);
      }
      expect(fs.existsSync(path.join(home, '.hermes'))).toBe(false);
    } finally {
      process.env.HOME = env.HOME;
      if (env.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = env.CODEX_HOME;
    }
  });
});
