import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectVcs } from '../vcs.js';

describe('detectProjectVcs', () => {
  it('returns git for repo root', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    expect(detectProjectVcs(repoRoot)).toBe('git');
  });

  it('returns none for non-repo directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tim-vcs-test-'));
    try {
      expect(detectProjectVcs(dir)).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
