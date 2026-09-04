import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(scriptsDir, '..');
const hook = join(scriptsDir, 'git-hooks', 'post-merge');

describe('post-merge / post-checkout dist guard hook', () => {
  it('is syntactically valid bash', () => {
    expect(() => execFileSync('bash', ['-n', hook])).not.toThrow();
  });

  // The hook is installed through core.hooksPath, which is global on this host,
  // so it runs on every repository. Anything but exit 0 would break unrelated
  // checkouts, and a stale build is far less bad than a checkout that fails.
  it('exits 0 in the TIM repo', () => {
    const r = spawnSync('bash', [hook], { cwd: repoRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('exits 0 and says nothing outside a git repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-probe-'));
    try {
      const r = spawnSync('bash', [hook], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 and says nothing in a git repo that is not TIM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-probe-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      const r = spawnSync('bash', [hook], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
