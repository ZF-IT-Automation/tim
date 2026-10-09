import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface UpdateSkillsResult {
  copied: { skill: string; target: string }[];
  skipped: string[];
}

export type SkillsHost = 'claude' | 'codex' | 'cursor' | 'hermes';

function bundledSkillsDir(): string {
  return (() => {
    const candidates = [
      path.join(process.cwd(), 'packages', 'tim-skills', 'skills'),
      path.join(__dirname, '..', '..', 'tim-skills', 'skills'),
      path.join(__dirname, '..', 'skills'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error('Bundled skills directory not found');
  })();
}

export function copySkillsTo(srcRoot: string, skillsBase: string): { skill: string; target: string }[] {
  const skillNames = fs.readdirSync(srcRoot).filter(name => {
    const p = path.join(srcRoot, name);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
  });

  if (!fs.existsSync(skillsBase)) fs.mkdirSync(skillsBase, { recursive: true });
  const copied: { skill: string; target: string }[] = [];
  for (const name of skillNames) {
    const from = path.join(srcRoot, name);
    // A host dir can be a symlink to a shared skills dir (~/.claude/skills/x ->
    // ~/.config/opencode/skills/x); cpSync refuses to overwrite a symlink, so copy
    // into its target.
    const dest = path.join(skillsBase, name);
    const to = fs.existsSync(dest) ? fs.realpathSync(dest) : dest;
    fs.cpSync(from, to, { recursive: true });
    copied.push({ skill: name, target: to });
  }
  return copied;
}

export function resolveHostSkillsBase(host: SkillsHost): string {
  const home = process.env.HOME || os.homedir();
  return (
    host === 'claude'
      ? path.join(home, '.claude', 'skills')
      : host === 'codex'
        ? path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'skills')
        : host === 'hermes'
          ? path.join(home, '.hermes', 'skills')
          : path.join(home, '.cursor', 'skills')
  );
}

export function updateSkillsForHost(host: SkillsHost): UpdateSkillsResult {
  const srcRoot = bundledSkillsDir();
  return { copied: copySkillsTo(srcRoot, resolveHostSkillsBase(host)), skipped: [] };
}

export function updateSkills(): UpdateSkillsResult {
  const srcRoot = bundledSkillsDir();
  const skipped: string[] = [];
  const copied: { skill: string; target: string }[] = [];
  const home = process.env.HOME || os.homedir();
  const bases = [
    ...(['claude', 'codex', 'hermes', 'cursor'] as const).map(resolveHostSkillsBase),
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.gemini', 'skills'),
  ];

  // A host is installed when its config dir (the skills dir's parent) exists.
  for (const base of bases) {
    if (fs.existsSync(path.dirname(base))) copied.push(...copySkillsTo(srcRoot, base));
  }

  if (copied.length === 0) {
    skipped.push('No supported hosts detected');
  }

  return { copied, skipped };
}
