import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, listRelatedProjects } from 'tim-store';
import { cmdProject } from '../project.js';

describe('tim project CLI', () => {
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `tim-project-cli-${Date.now()}.db`);
    const store = new TimStore(dbPath);
    await store.createProject('P0940', { content: 'One' });
    await store.createProject('P0941', { content: 'Two' });
    await store.createProject('P0942', { content: 'Game Harness\n## Project Stats\n9 entries' });
    store.close();
    process.env.TIM_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TIM_DB_PATH;
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('relate and related subcommands', async () => {
    await cmdProject(['relate', 'P0940', 'P0941']);
    const store = new TimStore(dbPath);
    const neighbours = await listRelatedProjects(store, 'P0940');
    store.close();
    expect(neighbours.map(n => n.label)).toEqual(['P0941']);
  });

  it('unrelate, related empty message, describe, and relate no-ops', async () => {
    const { spawnSync } = await import('node:child_process');
    const run = (args: string[]) =>
      spawnSync(process.execPath, [path.resolve(__dirname, '../../dist/cli.js'), 'project', ...args], {
        encoding: 'utf8',
        env: { ...process.env, TIM_DB_PATH: dbPath },
      });

    let out = run(['relate', 'P0940', 'P0940']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('same project');

    out = run(['relate', 'P0940', 'P0941']);
    expect(out.stdout).toContain('Related');

    out = run(['relate', 'P0941', 'P0940']);
    expect(out.stdout).toContain('Already related');

    out = run(['related', 'P0940']);
    expect(out.stdout).toContain('P0941');

    out = run(['describe', 'P0940', 'Alpha tooling']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Description set');

    out = run(['interfaces', 'P0940']);
    expect(out.stdout).toContain('No interfaces recorded');
    out = run(['interfaces', 'P0940', '--set', 'CLI: one run']);
    expect(out.stdout).toContain('Interfaces set');
    out = run(['interfaces', 'P0940']);
    expect(out.stdout).toContain('CLI: one run');

    out = run(['unrelate', 'P0940', 'P0941']);
    expect(out.stdout).toContain('Unrelated');

    out = run(['related', 'P0940']);
    expect(out.stdout).toContain('No related projects');

    out = run(['unrelate', 'P0940', 'P0941']);
    expect(out.stdout).toContain('No related edge');
  }, 30_000);

  it('takes names in any spelling, lists candidates on a miss, defaults to the marker project', async () => {
    const { spawnSync } = await import('node:child_process');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-project-cli-repo-'));
    const inner = path.join(repo, 'src');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(repo, '.tim-project'), JSON.stringify({ version: 3, project: 'P0940' }));
    const run = (args: string[], cwd = process.cwd()) =>
      spawnSync(process.execPath, [path.resolve(__dirname, '../../dist/cli.js'), 'project', ...args], {
        encoding: 'utf8',
        cwd,
        env: { ...process.env, TIM_DB_PATH: dbPath },
      });
    try {
      let out = run(['relate', 'one', 'GAME-harness']);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('Related P0940 One ↔ P0942 Game Harness');

      out = run(['relate', 'one', 'nope']);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain('No project matches "nope"');
      expect(out.stderr).toContain('P0942 Game Harness');

      out = run(['related'], inner);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('P0942 — Game Harness ·');
      expect(out.stdout).not.toContain('Project Stats');

      out = run(['describe', 'The first test project.'], inner);
      expect(out.stdout).toContain('Description set for P0940 One');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000); // eight sequential CLI spawns exceed the 5s default under a loaded full run
});
