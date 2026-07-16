import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TimStore } from 'tim-store';

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
      JSON.stringify({ project: 'P0063', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
    expect(run(['resolve-project', '--cwd', dir], { TIM_MARKER_MAX_ROOT: dir }).trim()).toBe('P0063');
  });

  it('resolve-project prints nothing and exits 0 when no marker', () => {
    expect(run(['resolve-project', '--cwd', dir], { TIM_MARKER_MAX_ROOT: dir }).trim()).toBe('');
  });

  it('resolve-project --format directive contains the load instruction', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ project: 'P0063', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], { TIM_MARKER_MAX_ROOT: dir });
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
    expect(run(['resolve-project', '--cwd', dir], { TIM_MARKER_MAX_ROOT: dir }).trim()).toBe('P0099');
  });

  it('bind-project is idempotent for the same live label and preserves counters', async () => {
    await store.createProject('P0100');
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 2, project: 'P0100', session: 's7', exchanges: 12, batch_size: 3, batches_summarized: 4 }));
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

  it('bind-project preserves an existing winner instead of overwriting it', async () => {
    await store.createProject('P0102');
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 2, project: 'P0103', session: 'winner', exchanges: 9, batch_size: 5, batches_summarized: 1 }));
    const before = fs.readFileSync(path.join(dir, '.tim-project'), 'utf8');

    const output = run(['bind-project', '--cwd', dir, '--label', 'P0102'], {
      TIM_MARKER_MAX_ROOT: dir,
      TIM_DB_PATH: dbPath,
    });

    expect(output).toMatch(/P0102.*P0103|P0103.*P0102/);
    expect(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8')).toBe(before);
  });
});
