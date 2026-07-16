import { execFileSync } from 'node:child_process';

export function detectProjectVcs(projectPath: string): 'git' | 'none' {
  try {
    const stdout = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (stdout.includes('true')) {
      return 'git';
    }
    return 'none';
  } catch {
    return 'none';
  }
}
