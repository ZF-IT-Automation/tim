import * as os from 'os';
import * as path from 'path';
import { TimStore, CommitManager, resolveCurrentSession } from 'tim-store';
import { loadConfig, type TimConfigFile } from 'tim-core';
import { findMarker, findMarkerOptionsFromEnv } from 'tim-hooks';
import { readGitCommit, isGitRepo } from './git-commit.js';
import { parseArgs, valueOptionsFor } from './args.js';

function getDbPath(config: TimConfigFile): string {
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

/** Record git commit under project Commits section. Silent skip when no .tim-project. */
export async function cmdRecordCommit(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('record-commit') });
  const cwd = flags.cwd ?? process.cwd();

  const located = findMarker(cwd, { walkUp: true, ...findMarkerOptionsFromEnv() });
  const projectId = flags.project ?? located?.marker.project;
  if (!projectId) return;

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
  const sessionId =
    flags.session ?? (await resolveCurrentSession(store, projectId, cwd))?.id ?? undefined;

  let hash = flags.hash;
  let message = flags.message;
  let diffSummary = flags.diff;
  let author = flags.author;
  let date = flags.date;
  let branch = flags.branch;

  if (!hash || !message) {
    if (!isGitRepo(cwd)) {
      console.error('Not a git repository and --hash/--message not provided');
      process.exit(1);
    }
    const info = readGitCommit(cwd, hash);
    hash = hash ?? info.hash;
    message = message ?? info.message;
    diffSummary = diffSummary ?? info.diffSummary;
    author = author ?? info.author;
    date = date ?? info.date;
    branch = branch ?? info.branch;
  }

  if (!hash || !message) {
    console.error(
      'Usage: tim record-commit [--cwd DIR] [--project LABEL] [--session ID] [--hash SHA] [--message TEXT] [--diff STAT]',
    );
    process.exit(1);
  }

  try {
    const mgr = new CommitManager(store);
    const entry = await mgr.recordCommit({
      projectId,
      hash,
      message,
      diffSummary,
      sessionId: sessionId || undefined,
      author,
      date,
      branch,
    });
    console.log(JSON.stringify(entry, null, 2));
  } finally {
    store.close();
  }
}
