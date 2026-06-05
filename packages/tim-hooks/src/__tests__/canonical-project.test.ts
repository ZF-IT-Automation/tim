import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CANONICAL_PROJECT_FILENAME } from '../marker.js';

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

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
});
