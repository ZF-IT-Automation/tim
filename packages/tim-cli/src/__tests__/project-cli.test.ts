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
});
