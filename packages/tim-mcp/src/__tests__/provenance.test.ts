import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureProvenance,
  commitsSince,
  commitsSinceCached,
  clearCommitsSinceCache,
  getCommitsSinceCacheStats,
} from '../provenance.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().trim();
}

describe('provenance', () => {
  let repo: string;
  let firstCommit: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-prov-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@test');
    git(repo, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'first');
    firstCommit = git(repo, 'rev-parse', '--short', 'HEAD');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('captures commit and branch in a git repo', () => {
    const prov = captureProvenance(repo);
    expect(prov).toEqual({ commit: firstCommit, branch: 'main' });
  });

  it('returns null outside a git repo', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-plain-'));
    try {
      expect(captureProvenance(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('counts commits since a stored commit', () => {
    expect(commitsSince(repo, firstCommit)).toBe(0);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'second');
    expect(commitsSince(repo, firstCommit)).toBe(1);
  });

  it('returns null for an unknown commit', () => {
    expect(commitsSince(repo, 'ffffffff')).toBeNull();
  });

  it('commitsSinceCached memoises by commit hash', () => {
    clearCommitsSinceCache();
    expect(commitsSinceCached(repo, firstCommit)).toBe(1);
    expect(commitsSinceCached(repo, firstCommit)).toBe(1);
    const stats = getCommitsSinceCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    clearCommitsSinceCache();
  });
});
