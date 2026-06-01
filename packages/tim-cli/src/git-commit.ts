import { execFileSync } from 'child_process';

export interface GitCommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
  branch: string;
  diffSummary: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** Read commit metadata from git. Defaults to HEAD when hash omitted. */
export function readGitCommit(cwd: string, hash?: string): GitCommitInfo {
  const h = hash ?? git(cwd, ['rev-parse', 'HEAD']);
  const message = git(cwd, ['log', '-1', '--format=%B', h]);
  const author = git(cwd, ['log', '-1', '--format=%an', h]);
  const date = git(cwd, ['log', '-1', '--format=%aI', h]);

  let branch = 'HEAD';
  try {
    branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    /* detached HEAD */
  }

  let diffSummary = '';
  try {
    diffSummary = git(cwd, ['show', '--stat', '--format=', h]);
  } catch {
    /* root commit or empty tree */
  }

  return { hash: h, message, author, date, branch, diffSummary };
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(cwd, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}
