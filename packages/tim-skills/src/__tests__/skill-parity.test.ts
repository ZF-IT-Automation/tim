import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TIM_SKILLS, type TimSkill } from '../index.js';

// `tim update-skills` copies every directory under skills/ that contains a
// SKILL.md — that is the only representation that reaches a host. A skill that
// exists only as a TS constant can be referenced (e.g. by the session-start
// directive) but will never install, so the two sets must stay identical.
const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
);

const FRONTMATTER = /^---\nname: (.+)\ndescription: (.+)\n---\n\n([\s\S]*)$/;

function installableSkillNames(): string[] {
  return fs
    .readdirSync(SKILLS_DIR)
    .filter(name => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
    .sort();
}

function parseSkillMd(name: string): TimSkill {
  const raw = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  const parts = raw.match(FRONTMATTER);
  if (!parts) throw new Error(`skills/${name}/SKILL.md has no parseable frontmatter`);
  return { name: parts[1], description: parts[2], content: parts[3] };
}

describe('skill parity (SKILL.md ↔ ALL_TIM_SKILLS)', () => {
  it('every installable skill is exported and every exported skill installs', () => {
    const onDisk = installableSkillNames();
    const exported = ALL_TIM_SKILLS.map(s => s.name).sort();
    expect(exported).toEqual(onDisk);
  });

  it('exported skill names are unique', () => {
    const names = ALL_TIM_SKILLS.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(installableSkillNames())(
    '%s: SKILL.md frontmatter and body match the exported constant',
    (name) => {
      const packaged = parseSkillMd(name);
      const exported = ALL_TIM_SKILLS.find(s => s.name === name);
      expect(exported, `${name} missing from ALL_TIM_SKILLS`).toBeDefined();
      expect(packaged.name).toBe(exported!.name);
      expect(packaged.description).toBe(exported!.description);
      expect(packaged.content).toBe(exported!.content);
    },
  );

  it('skills referenced by the session-start directive are installable', () => {
    // buildLoadDirective / buildSessionDirective point agents at these by name.
    for (const referenced of ['tim-session-start', 'tim-resume']) {
      expect(installableSkillNames()).toContain(referenced);
    }
  });
});
