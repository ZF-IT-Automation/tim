import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TimStore } from 'tim-store';
import { previewSessionStart } from '../checkpoint.js';

const DAY_MS = 86_400_000;

function gitEnv(iso: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  };
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
}

function commitAt(repo: string, message: string, iso: string): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message], {
    cwd: repo,
    env: gitEnv(iso),
    stdio: 'ignore',
  });
}

describe('stale project brief in the session-start directive', () => {
  const dirs: string[] = [];
  let store: TimStore;

  afterEach(() => {
    store?.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  async function projectWithActivity(
    label: string,
    repoPath: string | undefined,
    lastActivity: string,
  ): Promise<void> {
    const project = await store.createProject(label, {
      content: `${label} brief`,
      ...(repoPath ? { metadata: { path: repoPath } } : {}),
    });
    const child = await store.write('activity', { parentId: project.id });
    store.getDb().prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(lastActivity, child.id);
  }

  it('warns when HEAD moved after the brief went quiet, and stays quiet otherwise', async () => {
    store = new TimStore(':memory:');
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * DAY_MS).toISOString();
    const hoursAgo = (n: number) => new Date(now - n * 3_600_000).toISOString();

    const moved = tmp('tim-stale-moved-');
    initRepo(moved);
    commitAt(moved, 'old architecture', daysAgo(30));
    commitAt(moved, 'split the store', daysAgo(2));
    commitAt(moved, 'rename the bus', daysAgo(1));
    const quietSince = daysAgo(20);
    await projectWithActivity('P0711', moved, quietSince);

    const idle = tmp('tim-stale-idle-');
    initRepo(idle);
    commitAt(idle, 'ancient commit', daysAgo(30));
    await projectWithActivity('P0712', idle, daysAgo(20));

    const busy = tmp('tim-stale-busy-');
    initRepo(busy);
    for (let i = 1; i <= 11; i++) {
      commitAt(busy, `vol-${String(i).padStart(2, '0')}`, hoursAgo(2));
    }
    await projectWithActivity('P0713', busy, daysAgo(1));

    const missing = tmp('tim-stale-missing-');
    await projectWithActivity('P0714', missing, daysAgo(20));

    await projectWithActivity('P0715', undefined, daysAgo(20));

    const behind = await previewSessionStart(store, {
      projectId: 'P0711',
      maxTokens: 400,
      cwd: missing,
    });
    const date = quietSince.slice(0, 10);
    const warning =
      `⚠ Brief is 2 commits behind HEAD (last activity ${date}) — ` +
      `check \`git log --oneline --since=${date}\` before trusting architecture statements.`;
    expect(behind.directive).toContain(warning);
    const warnAt = behind.directive.indexOf(warning);
    const splitAt = behind.directive.indexOf('split the store');
    const renameAt = behind.directive.indexOf('rename the bus');
    expect(renameAt).toBeGreaterThan(warnAt);
    expect(splitAt).toBeGreaterThan(renameAt);
    expect(behind.directive.indexOf('ACTION:')).toBeGreaterThan(splitAt);
    expect(behind.directive).not.toContain('old architecture');

    const untouched = await previewSessionStart(store, {
      projectId: 'P0712',
      maxTokens: 400,
      cwd: idle,
    });
    expect(untouched.directive).not.toContain('⚠ Brief is');

    const many = await previewSessionStart(store, {
      projectId: 'P0713',
      maxTokens: 400,
      cwd: missing,
    });
    expect(many.directive).toContain('⚠ Brief is 11 commits behind HEAD');
    const subjects = many.directive.split('\n').filter(line => line.includes('vol-'));
    expect(subjects.map(line => line.trim())).toEqual([
      'vol-11', 'vol-10', 'vol-09', 'vol-08', 'vol-07',
    ]);
    expect(many.directive).not.toContain('vol-01');

    const noRepo = await previewSessionStart(store, {
      projectId: 'P0714',
      maxTokens: 400,
      cwd: moved,
    });
    expect(noRepo.directive).not.toContain('⚠ Brief is');

    const noPath = await previewSessionStart(store, {
      projectId: 'P0715',
      maxTokens: 400,
      cwd: moved,
    });
    expect(noPath.directive).not.toContain('⚠ Brief is');
  });
});
