import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = path.join(os.tmpdir(), 'tim-cli-help-tests');

interface HelpCase {
  args: string[];
  usage: string;
}

const HELP_CASES: HelpCase[] = [
  { args: [], usage: 'Usage: tim <command>' },
  { args: ['init'], usage: 'Usage: tim init' },
  { args: ['doctor'], usage: 'Usage: tim doctor' },
  { args: ['stats'], usage: 'Usage: tim stats' },
  { args: ['resolve-project'], usage: 'Usage: tim resolve-project' },
  { args: ['resolve-session'], usage: 'Usage: tim resolve-session' },
  { args: ['bind-project'], usage: 'Usage: tim bind-project' },
  { args: ['new-project'], usage: 'Usage: tim new-project' },
  { args: ['record-commit'], usage: 'Usage: tim record-commit' },
  { args: ['hook'], usage: 'Usage: tim hook' },
  { args: ['hook', 'session-start'], usage: 'Usage: tim hook session-start' },
  { args: ['hook', 'session-end'], usage: 'Usage: tim hook session-end' },
  { args: ['hook', 'log'], usage: 'Usage: tim hook log' },
  { args: ['checkpoint'], usage: 'Usage: tim checkpoint' },
  { args: ['rebalance'], usage: 'Usage: tim rebalance' },
  { args: ['statusline'], usage: 'Usage: tim statusline' },
  { args: ['setup-hermes-statusline'], usage: 'Usage: tim setup-hermes-statusline' },
  { args: ['export'], usage: 'Usage: tim export' },
  { args: ['import'], usage: 'Usage: tim import' },
  { args: ['migrate-from-hmem'], usage: 'Usage: tim migrate-from-hmem' },
  { args: ['migrate'], usage: 'Usage: tim migrate' },
  { args: ['migrate', 'tags-to-types'], usage: 'Usage: tim migrate tags-to-types' },
  { args: ['migrate', 'project-kind'], usage: 'Usage: tim migrate project-kind' },
  { args: ['snapshot'], usage: 'Usage: tim snapshot' },
  { args: ['restore'], usage: 'Usage: tim restore' },
  { args: ['release-check'], usage: 'Usage: tim release-check' },
  { args: ['setup-agent'], usage: 'Usage: tim setup-agent' },
  { args: ['sync'], usage: 'Usage: tim sync' },
  { args: ['sync', 'connect'], usage: 'Usage: tim sync connect' },
  { args: ['sync', 'disconnect'], usage: 'Usage: tim sync disconnect' },
  { args: ['sync', 'push'], usage: 'Usage: tim sync push' },
  { args: ['sync', 'pull'], usage: 'Usage: tim sync pull' },
  { args: ['sync', 'status'], usage: 'Usage: tim sync status' },
  { args: ['sync', 'dev'], usage: 'Usage: tim sync dev' },
  { args: ['root-entries'], usage: 'Usage: tim root-entries' },
  { args: ['consolidate'], usage: 'Usage: tim consolidate' },
  { args: ['consolidate', 'find-duplicates'], usage: 'Usage: tim consolidate find-duplicates' },
  { args: ['consolidate', 'find-decay'], usage: 'Usage: tim consolidate find-decay' },
  { args: ['consolidate', 'run'], usage: 'Usage: tim consolidate run' },
  { args: ['consolidate', 'status'], usage: 'Usage: tim consolidate status' },
  { args: ['secret'], usage: 'Usage: tim secret' },
  { args: ['secret', 'set'], usage: 'Usage: tim secret set' },
  { args: ['secret', 'status'], usage: 'Usage: tim secret status' },
  { args: ['secret', 'list'], usage: 'Usage: tim secret list' },
  { args: ['user'], usage: 'Usage: tim user' },
  { args: ['user', 'init'], usage: 'Usage: tim user init' },
  { args: ['user', 'profile'], usage: 'Usage: tim user profile' },
  { args: ['update-skills'], usage: 'Usage: tim update-skills' },
  { args: ['--version'], usage: 'Usage: tim --version' },
  { args: ['-v'], usage: 'Usage: tim --version' },
];

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const absolute = path.join(dir, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        visit(absolute);
      } else {
        snapshot[relative] = fs.readFileSync(absolute, 'utf8');
      }
    }
  };
  visit(root);
  return snapshot;
}

describe('tim CLI help safety', () => {
  let caseRoot: string;
  let homeDir: string;
  let cwd: string;
  let dbPath: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    caseRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'case-'));
    homeDir = path.join(caseRoot, 'home');
    cwd = path.join(caseRoot, 'workspace');
    fs.mkdirSync(homeDir);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.tim-project'), '{"project":"P0042"}\n');
    const blockedParent = path.join(caseRoot, 'not-a-directory');
    fs.writeFileSync(blockedParent, 'database access must not reach this path');
    dbPath = path.join(blockedParent, 'missing', 'tim.db');
  });

  afterEach(() => {
    fs.rmSync(caseRoot, { recursive: true, force: true });
  });

  for (const { args, usage } of HELP_CASES) {
    for (const helpFlag of ['-h', '--help']) {
      const invocation = [...args, helpFlag];
      it(`${invocation.join(' ')} exits zero and makes no filesystem changes`, () => {
        const before = snapshotTree(caseRoot);
        const result = spawnSync('node', [CLI, ...invocation], {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: homeDir,
            TIM_DB_PATH: dbPath,
          },
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(usage);
        expect(result.stderr).toBe('');
        expect(snapshotTree(caseRoot)).toEqual(before);
      });
    }
  }
});
