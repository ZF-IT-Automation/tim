import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOST_TOOLS } from './install.js';

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

function copySkillsTo(srcRoot: string, skillsBase: string): { skill: string; target: string }[] {
  const skillNames = fs.readdirSync(srcRoot).filter(name => {
    const p = path.join(srcRoot, name);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
  });

  if (!fs.existsSync(skillsBase)) fs.mkdirSync(skillsBase, { recursive: true });
  const copied: { skill: string; target: string }[] = [];
  for (const name of skillNames) {
    const from = path.join(srcRoot, name);
    const to = path.join(skillsBase, name);
    fs.cpSync(from, to, { recursive: true });
    copied.push({ skill: name, target: to });
  }
  return copied;
}

export function resolveHostSkillsBase(host: SkillsHost): string | null {
  const home = process.env.HOME || os.homedir();
  return (
    host === 'claude'
      ? path.join(home, '.claude', 'skills')
      : host === 'codex'
        ? path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'skills')
        : host === 'hermes'
          ? path.join(home, '.hermes', 'skills')
          : null
  );
}

export function updateSkillsForHost(host: SkillsHost): UpdateSkillsResult {
  const srcRoot = bundledSkillsDir();
  const skillsBase = resolveHostSkillsBase(host);

  if (!skillsBase) {
    return { copied: [], skipped: ['Cursor has no TIM skill install path; use MCP guidance instead'] };
  }
  return { copied: copySkillsTo(srcRoot, skillsBase), skipped: [] };
}

export function updateSkills(): UpdateSkillsResult {
  const srcRoot = bundledSkillsDir();
  const skipped: string[] = [];
  const copied: { skill: string; target: string }[] = [];
  const home = process.env.HOME || os.homedir();

  for (const tool of HOST_TOOLS) {
    if (!tool.detect()) continue;
    const skillsBase = tool.id === 'claude-code'
      ? path.join(home, '.claude', 'skills')
      : tool.id === 'opencode'
        ? path.join(home, '.config', 'opencode', 'skills')
        : null;
    if (!skillsBase) {
      skipped.push(`${tool.name} (no skills dir)`);
      continue;
    }
    copied.push(...copySkillsTo(srcRoot, skillsBase));
  }

  if (copied.length === 0 && skipped.length === 0) {
    skipped.push('No supported hosts detected');
  }

  return { copied, skipped };
}
