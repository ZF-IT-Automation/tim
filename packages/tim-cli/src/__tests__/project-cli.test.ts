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

    out = run(['unrelate', 'P0940', 'P0941']);
    expect(out.stdout).toContain('Unrelated');

    out = run(['related', 'P0940']);
    expect(out.stdout).toContain('No related projects');

    out = run(['unrelate', 'P0940', 'P0941']);
    expect(out.stdout).toContain('No related edge');
  }, 30_000); // eight sequential CLI spawns exceed the 5s default under a loaded full run
});
