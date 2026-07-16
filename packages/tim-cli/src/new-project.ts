import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { execSync } from 'child_process';
import {
  TimStore,
  isProjectLabelConflictError,
  nextLabelAfterProjectLabelConflict,
} from 'tim-store';
import { loadConfig } from 'tim-core';
import {
  createProjectCoordinated,
  ProjectCreationPartialFailureError,
  readMarker,
  type BoundProjectCreationResult,
} from 'tim-hooks';
import { NEW_PROJECT_ALIASES, parseArgs, valueOptionsFor } from './args.js';

const STANDARD_SECTIONS = [
  { label: 'Tasks', content: 'Actionable work items and open tasks' },
  { label: 'Ideas', content: 'Brainstorming and undecided proposals' },
  { label: 'Errors', content: 'Bug and error tracking' },
  { label: 'Decisions', content: 'Architecture and project decisions' },
  { label: 'Learnings', content: 'Lessons learned and pitfalls' },
  { label: 'Log', content: 'Project activity log and milestones' },
  { label: 'Testing', content: 'Test scenarios, test plans, coverage notes, and testing methodologies' },
] as const;

function getDbPath(): string {
  const config = loadConfig();
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

function exitWith(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function validateName(name: string): void {
  if (!name?.trim()) {
    exitWith(1, 'Error: --name is required and must be non-empty');
  }
}

function precheckNewProjectPath(requestedPath: string): string {
  const environmentShorthand = /\$(?:\{|[A-Za-z_])|%[A-Za-z_][A-Za-z0-9_]*%/;
  if (requestedPath.startsWith('~') || environmentShorthand.test(requestedPath)) {
    exitWith(1, `Error: Invalid --path: home and environment shorthand are not supported (got: ${requestedPath})`);
  }
  if (!path.isAbsolute(requestedPath)) {
    exitWith(1, `Error: Invalid --path: must be absolute path (got: ${requestedPath})`);
  }

  const targetPath = path.resolve(requestedPath);
  if (targetPath === fs.realpathSync(os.homedir())) {
    exitWith(1, `Error: Invalid --path: refusing home directory (${targetPath})`);
  }
  if (!fs.existsSync(targetPath)) return targetPath;

  const targetStat = fs.statSync(targetPath);
  if (!targetStat.isDirectory()) {
    exitWith(1, `Error: Invalid --path: existing target must be a directory (${targetPath})`);
  }
  if (fs.realpathSync(targetPath) === fs.realpathSync(os.homedir())) {
    exitWith(1, `Error: Invalid --path: refusing home directory (${targetPath})`);
  }

  const markerFile = path.join(targetPath, '.tim-project');
  try {
    fs.lstatSync(markerFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return targetPath;
    throw err;
  }

  const boundLabel = readMarker(targetPath)?.project ?? 'unknown';
  exitWith(
    1,
    `Error: Path already bound to ${boundLabel}. tim bind-project is recovery-only and cannot replace a different marker. ` +
      'Inspect the existing binding, reconcile the database projects if necessary, and remove `.tim-project` only when it is confirmed stale; then retry tim new-project.',
  );
}

function countDirEntries(dir: string): number {
  try {
    return fs.readdirSync(dir).filter(name => name !== '.git').length;
  } catch {
    return 0;
  }
}

async function promptContinue(fileCount: number, targetPath: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => {
    rl.question(
      `⚠ Directory ${targetPath} is not empty (${fileCount} files).\n` +
        '  Continue anyway? Existing files will not be touched. [y/N]: ',
      ans => {
        rl.close();
        resolve(ans.trim());
      },
    );
  });
  if (answer !== 'y' && answer !== 'Y') {
    exitWith(6, 'Aborted by user');
  }
}

async function createProjectWithRetry(
  store: TimStore,
  startLabel: string,
  name: string,
  targetPath: string,
  deps: NewProjectDeps,
): Promise<BoundProjectCreationResult> {
  let label = startLabel;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const result = await deps.createProject(store, {
        label,
        path: targetPath,
        content: name,
        metadata: { name },
      });
      if (result.mode !== 'bound') {
        throw new Error('Coordinated project creation unexpectedly returned a memory-only project');
      }
      return result;
    } catch (err) {
      if (isProjectLabelConflictError(err)) {
        label = nextLabelAfterProjectLabelConflict(store, label);
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `Could not allocate a project label after 10 concurrent collisions starting at ${startLabel}. ` +
      'Retry tim new-project after the other project creations finish.',
  );
}

export interface NewProjectDeps {
  createProject: typeof createProjectCoordinated;
}

const DEFAULT_NEW_PROJECT_DEPS: NewProjectDeps = {
  createProject: createProjectCoordinated,
};

async function initProjectSchema(store: TimStore, projectId: string): Promise<void> {
  for (const section of STANDARD_SECTIONS) {
    try {
      await store.write(section.content, {
        parentId: projectId,
        metadata: { kind: 'section', label: section.label },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: failed to create section ${section.label}: ${msg}`);
    }
  }
}

export async function cmdNewProject(
  args: string[],
  deps: NewProjectDeps = DEFAULT_NEW_PROJECT_DEPS,
): Promise<void> {
  const { flags } = parseArgs(args, {
    valueOptions: valueOptionsFor('new-project'),
    aliases: NEW_PROJECT_ALIASES,
  });

  if (flags.help === 'true') {
    console.log(`Usage: tim new-project --path <dir> --name <string> [--no-git] [--confirm]
       tim new-project -p <dir> -n <string> [--no-git] [--confirm]

Create a new TIM project, register it in the database, write .tim-project, and initialize standard sections.`);
    return;
  }

  const requestedPath = flags.path ?? '';
  const name = flags.name ?? '';
  const noGit = flags['no-git'] === 'true';
  const confirm = flags.confirm === 'true';

  if (!requestedPath) {
    exitWith(1, 'Error: --path is required');
  }
  validateName(name);
  const targetPath = precheckNewProjectPath(requestedPath);

  if (!fs.existsSync(targetPath)) {
    try {
      fs.mkdirSync(targetPath, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      exitWith(3, `Error: mkdir failed: ${msg}`);
    }
  }

  const fileCount = countDirEntries(targetPath);
  if (fileCount > 0 && !confirm) {
    if (!process.stdin.isTTY) {
      exitWith(
        6,
        `Error: Directory ${targetPath} is not empty (${fileCount} files). Use --confirm to proceed non-interactively.`,
      );
    }
    await promptContinue(fileCount, targetPath);
  }

  const dbPath = getDbPath();
  const store = new TimStore(dbPath);

  let result: BoundProjectCreationResult;
  try {
    const startLabel = store.allocateNextProjectLabel();
    result = await createProjectWithRetry(store, startLabel, name.trim(), requestedPath, deps);
  } catch (err) {
    store.close();
    if (
      !(err instanceof ProjectCreationPartialFailureError) &&
      err instanceof Error &&
      /target-local project marker already exists/i.test(err.message)
    ) {
      throw new Error(
        `${err.message} tim bind-project is recovery-only and cannot replace a different marker. ` +
          'Inspect the existing binding, reconcile the database projects if necessary, and remove the marker only when it is confirmed stale; then retry tim new-project.',
      );
    }
    if (err instanceof ProjectCreationPartialFailureError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    exitWith(5, `Error: Failed to create project in database: ${msg}`);
  }

  await initProjectSchema(store, result.id);

  if (!noGit) {
    const gitDir = path.join(targetPath, '.git');
    if (fs.existsSync(gitDir)) {
      console.log('⊘ Git repo already initialized');
    } else {
      try {
        execSync('git init', { cwd: targetPath, stdio: 'pipe' });
        console.log('✓ Git repo initialized');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Warning: git init failed: ${msg}. DB + marker are in place — run 'cd ${targetPath} && git init' manually.`,
        );
        store.close();
        process.exit(4);
      }
    }
  } else {
    console.log('⊘ Git init skipped (--no-git)');
  }

  const createdLabel = String(result.metadata.label);
  console.log(`✓ Created project ${createdLabel} "${name.trim()}" at ${result.projectPath}`);
  console.log(`✓ .tim-project written — next session in this dir binds to ${createdLabel}`);

  store.close();
}
