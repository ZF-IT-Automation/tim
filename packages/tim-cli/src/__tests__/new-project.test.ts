import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { TimStore } from 'tim-store';
import { createProjectCoordinated } from 'tim-hooks';
import { cmdNewProject } from '../new-project.js';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = path.join(os.tmpdir(), 'tim-new-project-tests');

function run(
  args: string[],
  env: Record<string, string> = {},
  input?: string,
): { stdout: string; stderr: string; status: number } {
  if (input !== undefined) {
    const result = spawnSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      input,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status ?? 1,
    };
  }
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

async function seedProject(dbPath: string, label: string, content = label): Promise<void> {
  const store = new TimStore(dbPath);
  await store.createProject(label, { content });
  store.close();
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${code}`);
  }) as ReturnType<typeof vi.spyOn>;
}

describe('tim new-project', () => {
  let workDir: string;
  let dbPath: string;
  let env: Record<string, string>;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    workDir = fs.mkdtempSync(path.join(TEST_ROOT, 'case-'));
    dbPath = path.join(workDir, 'test.db');
    env = { TIM_DB_PATH: dbPath, TIM_MARKER_MAX_ROOT: workDir };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('creates non-existent path', () => {
    const target = path.join(workDir, 'new-dir');
    const result = run(['new-project', '-p', target, '-n', 'Fresh'], env);
    expect(result.status).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(true);
  });

  it('uses existing empty directory', () => {
    const target = path.join(workDir, 'empty-existing');
    fs.mkdirSync(target);
    const result = run(['new-project', '--path', target, '--name', 'Empty Dir'], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✓ Created project P0001');
  });

  it('prompts on non-empty directory with TTY', async () => {
    const target = path.join(workDir, 'nonempty-tty');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'file1.txt'), 'x');

    const exitSpy = mockExit();
    const prevIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.spyOn(readline.Interface.prototype, 'question').mockImplementation(
      ((_q: string, cb: (answer: string) => void) => {
        cb('n');
        return {} as readline.Interface;
      }) as typeof readline.Interface.prototype.question,
    );

    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = dbPath;
    await expect(
      cmdNewProject(['--path', target, '--name', 'TTY Test']),
    ).rejects.toThrow('exit:6');
    if (prevDb === undefined) delete process.env.TIM_DB_PATH;
    else process.env.TIM_DB_PATH = prevDb;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevIsTTY, configurable: true });
    exitSpy.mockRestore();

    const store = new TimStore(dbPath);
    const projects = await store.listProjects();
    expect(projects).toHaveLength(0);
    store.close();
  });

  it('fails safely in non-TTY without --confirm', async () => {
    const target = path.join(workDir, 'nonempty-pipe');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'file1.txt'), 'x');

    const result = run(['new-project', '-p', target, '-n', 'Pipe Test'], env, 'n\n');
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/not empty|non-interactively/i);
    expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(false);

    const store = new TimStore(dbPath);
    const projects = await store.listProjects();
    expect(projects).toHaveLength(0);
    store.close();
  });

  it('rejects existing marker with hard error', async () => {
    const target = path.join(workDir, 'has-marker');
    fs.mkdirSync(target);
    const markerContent = JSON.stringify({
      version: 2,
      project: 'P0042',
      session: 'sess',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    });
    fs.writeFileSync(path.join(target, '.tim-project'), markerContent);

    const result = run(['new-project', '-p', target, '-n', 'Blocked'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Path already bound to P0042');
    expect(result.stderr).toMatch(/reconcil/i);
    expect(result.stderr).not.toContain('to rebind');
    expect(fs.readFileSync(path.join(target, '.tim-project'), 'utf8')).toBe(markerContent);
    expect(fs.existsSync(path.join(target, '.tim-project.bak'))).toBe(false);

    const store = new TimStore(dbPath);
    const projects = await store.listProjects();
    expect(projects).toHaveLength(0);
    store.close();
  });

  it('skips existing git repo', () => {
    const target = path.join(workDir, 'has-git');
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(target, '.git'));

    const result = run(['new-project', '-p', target, '-n', 'Git Exists'], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('⊘ Git repo already initialized');
  });

  it('respects --no-git', () => {
    const target = path.join(workDir, 'no-git');
    const result = run(['new-project', '-p', target, '-n', 'No Git', '--no-git'], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('⊘ Git init skipped (--no-git)');
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  });

  it('retries on label collision', async () => {
    const target = path.join(workDir, 'collision');
    await seedProject(dbPath, 'P0001');
    const labels: string[] = [];
    const createProject: typeof createProjectCoordinated = async (store, args) => {
      labels.push(args.label);
      expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(false);
      if (args.label === 'P0002') {
        throw new Error('Project label already exists: P0002 (dup-id)');
      }
      return createProjectCoordinated(store, args);
    };

    const prevDb = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = dbPath;
    await cmdNewProject(['--path', target, '--name', 'Collision Test'], { createProject });
    if (prevDb === undefined) delete process.env.TIM_DB_PATH;
    else process.env.TIM_DB_PATH = prevDb;

    expect(labels).toEqual(['P0002', 'P0003']);
    expect(JSON.parse(fs.readFileSync(path.join(target, '.tim-project'), 'utf8')).project).toBe('P0003');
    const store = new TimStore(dbPath);
    const projects = await store.listProjects();
    expect(projects.some(p => p.label === 'P0002')).toBe(false);
    expect(projects.some(p => p.label === 'P0003')).toBe(true);
    store.close();
  });

  it('starts at P0001 for empty DB', () => {
    const target = path.join(workDir, 'first-project');
    const result = run(['new-project', '-p', target, '-n', 'First'], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('P0001');

    const marker = JSON.parse(fs.readFileSync(path.join(target, '.tim-project'), 'utf8'));
    expect(marker.project).toBe('P0001');
  });

  it('rejects home directory', () => {
    const home = os.homedir();
    const result = run(['new-project', '-p', home, '-n', 'Home'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/home directory|Invalid --path/i);
  });

  it('rejects relative path', () => {
    const relative = `relative-${path.basename(workDir)}/path`;
    const resolved = path.resolve(relative);
    const result = run(['new-project', '-p', relative, '-n', 'Bad'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be absolute path');
    expect(fs.existsSync(resolved)).toBe(false);
  });

  it.each(['~/tim-project', '$HOME/tim-project', '%HOME%/tim-project'])(
    'rejects path shorthand without creating directories: %s',
    shorthand => {
      const resolved = path.resolve(shorthand);
      const result = run(['new-project', '-p', shorthand, '-n', 'Bad'], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/shorthand|absolute path/i);
      expect(fs.existsSync(resolved)).toBe(false);
    },
  );

  it('rejects an existing non-directory target before confirmation', () => {
    const target = path.join(workDir, 'existing-file');
    fs.writeFileSync(target, 'not a directory');

    const result = run(['new-project', '-p', target, '-n', 'Bad'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must be a directory/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('not a directory');
  });

  it('rejects empty name', () => {
    const target = path.join(workDir, 'empty-name');
    const result = run(['new-project', '-p', target, '-n', ''], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/name.*required|non-empty/i);
  });

  it('confirm skips prompt non-interactively', () => {
    const target = path.join(workDir, 'confirm-nonempty');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'data');

    const result = run(
      ['new-project', '-p', target, '-n', 'Confirmed', '--confirm'],
      env,
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(true);
  });

  it('exits on mkdir failure', () => {
    const blocker = path.join(workDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'blocked');
    const target = path.join(blocker, 'child');

    const result = run(['new-project', '-p', target, '-n', 'Mkdir Fail'], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/mkdir failed/i);
  });

  it('warns on git init failure', async () => {
    const target = path.join(workDir, 'git-fail');
    const fakeBin = path.join(workDir, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const result = run(
      ['new-project', '-p', target, '-n', 'Git Fail'],
      { ...env, PATH: `${fakeBin}:${process.env.PATH}` },
    );
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/git init failed/i);
    expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(true);

    const store = new TimStore(dbPath);
    const projects = await store.listProjects();
    expect(projects).toHaveLength(1);
    store.close();
  });

  it('ignores P9999 sentinel', async () => {
    await seedProject(dbPath, 'P0000', 'Inbox');
    await seedProject(dbPath, 'P9999', 'Sentinel');

    const target = path.join(workDir, 'after-sentinel');
    const result = run(['new-project', '-p', target, '-n', 'After Sentinel'], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('P0001');
  });

  it('creates_full_project_schema', async () => {
    const target = path.join(workDir, 'full-schema');
    const result = run(['new-project', '-p', target, '-n', 'Schema Test'], env);
    expect(result.status).toBe(0);

    const store = new TimStore(dbPath);
    const loaded = await store.loadProject('P0001', { depth: 1 });
    expect(loaded).not.toBeNull();
    const sections = loaded!.children.filter(c => c.metadata.kind === 'section');
    expect(sections).toHaveLength(7);
    const labels = sections.map(s => s.metadata.label).sort();
    expect(labels).toEqual(['Decisions', 'Errors', 'Ideas', 'Learnings', 'Log', 'Tasks', 'Testing']);
    store.close();
  });

  it('does not support --force', () => {
    const target = path.join(workDir, 'force-blocked');
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(target, '.tim-project'),
      JSON.stringify({
        version: 2,
        project: 'P0099',
        session: 's',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      }),
    );

    const result = run(['new-project', '-p', target, '-n', 'Force', '--force'], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Path already bound to P0099');
    expect(fs.existsSync(path.join(target, '.tim-project.bak'))).toBe(false);
  });

  it('happy path produces correct marker version 2', () => {
    const target = path.join(workDir, 'marker-v2');
    const result = run(['new-project', '-p', target, '-n', 'Marker V2'], env);
    expect(result.status).toBe(0);
    const marker = JSON.parse(fs.readFileSync(path.join(target, '.tim-project'), 'utf8'));
    expect(marker.version).toBe(2);
    expect(marker.project).toBe('P0001');
    expect(marker.batch_size).toBe(5);
    expect(marker.exchanges).toBe(0);
    expect(marker.batches_summarized).toBe(0);
    expect(marker.session).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('metadata.path and metadata.name stored', async () => {
    const target = path.join(workDir, 'meta-fields');
    const result = run(['new-project', '-p', target, '-n', 'Meta Name'], env);
    expect(result.status).toBe(0);

    const store = new TimStore(dbPath);
    const loaded = await store.loadProject('P0001');
    expect(loaded!.project.metadata.name).toBe('Meta Name');
    expect(loaded!.project.metadata.path).toBe(target);
    store.close();
  });
});
