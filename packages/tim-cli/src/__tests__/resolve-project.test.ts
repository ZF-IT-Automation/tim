import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, listProjectPathRows } from 'tim-store';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = '/tmp/tim-test-runs';

function run(args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

describe('tim resolve-project / bind-project', () => {
  let dir: string;
  let dbPath: string;
  let store: TimStore;
  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'cli-'));
    dbPath = path.join(dir, 'tim.db');
    store = new TimStore(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolve-project prints the label (default format)', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0063' }));
    expect(run(['resolve-project', '--cwd', dir], { TIM_MARKER_MAX_ROOT: dir }).trim()).toBe('P0063');
  });

  it('resolve-project prints nothing and exits 0 when no marker', () => {
    expect(run(['resolve-project', '--cwd', dir], { TIM_MARKER_MAX_ROOT: dir }).trim()).toBe('');
  });

  it('resolve-project --format directive contains the load instruction', async () => {
    const store = new TimStore(dbPath);
    await store.createProject('P0063');
    store.close();
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0063' }));
    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], {
      TIM_DB_PATH: dbPath,
      TIM_MARKER_MAX_ROOT: dir,
    });
    expect(out).toContain('tim_load_project(label="P0063")');
  });

  it('bind-project recovers a live project marker; resolve-project reads it back', async () => {
    await store.createProject('P0099');
    const output = run(['bind-project', '--cwd', dir, '--label', 'P0099'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });
    expect(output).toContain('Wrote .tim-project');
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker.project).toBe('P0099');
    expect(run(['resolve-project', '--cwd', dir], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    }).trim()).toBe('P0099');
  });

  it('resolve-project label format marks unrepaired phantom with ?', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0888' }));
    expect(run(['resolve-project', '--cwd', dir], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    }).trim()).toBe('P0888?');
  });

  it('bind-project is idempotent for the same live label', async () => {
    await store.createProject('P0100');
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0100' }));
    const before = fs.readFileSync(path.join(dir, '.tim-project'));
    const output = run(['bind-project', '--cwd', dir, '--label', 'P0100'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });
    expect(output).toContain('Already bound');
    expect(fs.readFileSync(path.join(dir, '.tim-project'))).toEqual(before);
  });

  it('bind-project requires the exact live label from the selected database', async () => {
    await store.createProject('P0104', { aliases: ['project-alias'] });
    const output = run(['bind-project', '--cwd', dir, '--label', 'project-alias'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });

    expect(output).toMatch(/not found/i);
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('bind-project rejects a missing DB label without writing a marker', () => {
    const output = run(['bind-project', '--cwd', dir, '--label', 'P0101'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });

    expect(output).toMatch(/not found/i);
    expect(fs.existsSync(path.join(dir, '.tim-project'))).toBe(false);
  });

  it('resolve-project --format directive emits repair guidance for an unrepaired phantom marker', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0063' }));
    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
      version: 3,
      project: 'P0888',
    }));
    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });
    expect(out).toContain('Stale TIM project marker');
    expect(out).toContain('tim bind-project --label <P00XX>');
    expect(out).not.toContain('tim_load_project');
  });

  it('resolve-project --format directive recovers phantom marker via alias', async () => {
    const alias = path.basename(dir).toLowerCase();
    await store.createProject('P0200', { content: 'Recovered', aliases: [alias] });
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0888' }));

    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });
    expect(out).toContain('tim_load_project(label="P0200")');
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker).toEqual({ version: 3, project: 'P0200' });
  });

  it('bind-project backfills metadata.path and seeds the path inventory', async () => {
    await store.createProject('P0105');
    const canonical = fs.realpathSync(dir);

    const output = run(['bind-project', '--cwd', dir, '--label', 'P0105'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });

    expect(output).toContain('Wrote .tim-project');
    const reopened = new TimStore(dbPath);
    try {
      expect((await reopened.loadProject('P0105'))?.project.metadata.path).toBe(canonical);
      const rows = await listProjectPathRows(reopened, 'P0105');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        metadata: {
          kind: 'project-path',
          device: os.hostname(),
          path: canonical,
        },
      });
    } finally {
      reopened.close();
    }
  });

  it('bind-project preserves an existing winner instead of overwriting it', async () => {
    await store.createProject('P0102');
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 3, project: 'P0103' }));
    const before = fs.readFileSync(path.join(dir, '.tim-project'), 'utf8');

    const output = run(['bind-project', '--cwd', dir, '--label', 'P0102'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });

    expect(output).toMatch(/P0102.*P0103|P0103.*P0102/);
    expect(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8')).toBe(before);
  });
});
