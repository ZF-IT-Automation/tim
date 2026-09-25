// One or two git calls at directive render time. A missing path, a non-repo,
// or any git failure yields no line — a stale brief is a warning, never a
// reason for the start hook to throw.
import { execFileSync } from 'node:child_process';
import type { TimStore } from 'tim-store';

const STALE_COMMIT_COUNT = 10;
const STALE_ACTIVITY_MS = 14 * 86_400_000;
const MAX_SUBJECTS = 5;
const SUBJECT_MAX_CHARS = 120;
const GIT_TIMEOUT_MS = 1000;

const GIT_OPTS = {
  timeout: GIT_TIMEOUT_MS,
  encoding: 'utf8' as const,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
};

function git(repoPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], GIT_OPTS);
  } catch {
    return null;
  }
}

function commitCountSince(repoPath: string, since: string): number | null {
  const out = git(repoPath, ['rev-list', '--count', `--since=${since}`, 'HEAD']);
  if (out === null) return null;
  const n = Number(out.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function shortSubject(subject: string): string {
  const one = subject.replace(/\s+/g, ' ').trim();
  const clipped = one.length <= SUBJECT_MAX_CHARS
    ? one
    : `${one.slice(0, SUBJECT_MAX_CHARS - 1).trimEnd()}…`;
  return `  ${clipped}`;
}

function commitSubjectsSince(repoPath: string, since: string): string[] {
  const out = git(repoPath, [
    'log', '-n', String(MAX_SUBJECTS), '--format=%s', `--since=${since}`, 'HEAD',
  ]);
  if (out === null) return [];
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, MAX_SUBJECTS)
    .map(shortSubject);
}

/**
 * Warning lines when the repo moved on after the brief's last activity.
 * Empty when nothing is stale, the project has no repo, or git cannot answer.
 * `lastActivity` is the store timestamp (`getProjectEntryStats`); the date in
 * the line is its calendar day, the count uses the full timestamp.
 */
export function briefStalenessLines(
  repoPath: string | undefined,
  lastActivity: string | undefined,
  nowMs: number = Date.now(),
): string[] {
  const repo = repoPath?.trim();
  const ts = lastActivity?.trim();
  if (!repo || !ts) return [];
  const lastMs = Date.parse(ts);
  if (!Number.isFinite(lastMs)) return [];

  const count = commitCountSince(repo, ts);
  if (count === null || count <= 0) return [];

  const staleByCount = count > STALE_COMMIT_COUNT;
  const staleByAge = nowMs - lastMs > STALE_ACTIVITY_MS;
  if (!staleByCount && !staleByAge) return [];

  const date = ts.slice(0, 10);
  const warning =
    `⚠ Brief is ${count} commits behind HEAD (last activity ${date}) — ` +
    `check \`git log --oneline --since=${date}\` before trusting architecture statements.`;
  return [warning, ...commitSubjectsSince(repo, ts)];
}

export async function loadBriefStalenessLines(
  store: TimStore,
  projectLabel: string,
): Promise<string[]> {
  try {
    const project = await store.requireProject(projectLabel);
    const repoPath = typeof project.metadata.path === 'string' ? project.metadata.path : undefined;
    const stats = store.getProjectEntryStats(project.id);
    // No descendants: the epoch sentinel is not a real "last activity".
    if (stats.count === 0) return [];
    return briefStalenessLines(repoPath, stats.lastActivity);
  } catch {
    return [];
  }
}
