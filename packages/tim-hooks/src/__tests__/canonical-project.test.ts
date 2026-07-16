import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildLoadDirective,
  buildSessionDirective,
  CANONICAL_PROJECT_FILENAME,
} from '../marker.js';

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const HOOK_SCRIPTS = [
  'tim-claude-session-start.sh',
  'post-commit.sh',
  'tim-session-start.sh',
  'tim-post-commit.sh',
  'tim-hermes-session-cache.sh',
  'tim-hermes-statusline.sh',
  'tim-cursor-inject.sh',
  'tim-statusline.sh',
];

describe('canonical project (repo structural guard)', () => {
  it('.gitignore lists .tim-project', () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/(^|\n)\.tim-project(\n|$)/);
  });

  it('.tim-project is not tracked by git', () => {
    const tracked = execSync('git ls-files .tim-project', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });

  it('tim.json exists with a valid project field', () => {
    const canonicalPath = path.join(REPO_ROOT, CANONICAL_PROJECT_FILENAME);
    expect(fs.existsSync(canonicalPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) as { project?: string };
    expect(typeof parsed.project).toBe('string');
    expect(parsed.project).toMatch(/^[PLEN]\d{4}$/);
  });

  it('all shipped hook entrypoints use the shared relocatable CLI resolver', () => {
    const scriptsDir = path.join(REPO_ROOT, 'packages/tim-hooks/scripts');
    const allHookText = HOOK_SCRIPTS.map((name) => {
      const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
      expect(source, name).toContain('lib/resolve-tim-cli.sh');
      return source;
    }).join('\n');

    expect(allHookText).not.toMatch(/\/home\/bbbee\/projects\/tim/);
  });

  it('directives reference the shipped tim-session-start skill', () => {
    for (const directive of [
      buildLoadDirective('P0063', '/repo'),
      buildSessionDirective('P0063', '/repo'),
    ]) {
      expect(directive).toContain('tim-session-start');
      expect(directive).not.toContain('o9k-session-start');
    }
  });
});
