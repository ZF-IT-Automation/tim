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
  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'cli-'));
    dbPath = path.join(dir, 'tim.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resolve-project prints the label (default format)', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ project: 'P0063', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
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
      JSON.stringify({ project: 'P0063', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], {
      TIM_DB_PATH: dbPath,
      TIM_MARKER_MAX_ROOT: dir,
    });
    expect(out).toContain('tim_load_project(label="P0063")');
  });

  it('emits repair guidance without a load action for a stale marker', () => {
    fs.writeFileSync(path.join(dir, 'tim.json'), JSON.stringify({ project: 'P0063' }));
    fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
      version: 2,
      project: 'P0777',
      session: 'stale-session',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    }));

    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], {
      TIM_DB_PATH: dbPath,
      TIM_MARKER_MAX_ROOT: dir,
    });

    expect(out).toContain('Stale TIM project marker');
    expect(out).toContain('tim bind-project --label <P00XX>');
    expect(out).not.toContain('tim_load_project');
    expect(out).not.toContain('P0063');
  });

  it('bind-project writes a marker; resolve-project reads it back', () => {
    run(['bind-project', '--cwd', dir, '--label', 'P0099'], { TIM_MARKER_MAX_ROOT: dir });
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker.project).toBe('P0099');
    expect(run(['resolve-project', '--cwd', dir], { TIM_MARKER_MAX_ROOT: dir }).trim()).toBe('P0099');
  });

  it('bind-project preserves existing counters, only changes project', () => {
    // Pre-seed with a label that satisfies the v2 PROJECT_LABEL_PATTERN
    // (`^[PLEN]\d{4}$`). Using a real-looking P-label exercises the
    // "preserves counters" path without tripping normalizeMarker's
    // pattern guard.
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ version: 2, project: 'P0063', session: 's7', exchanges: 12, batch_size: 3, batches_summarized: 4 }));
    run(['bind-project', '--cwd', dir, '--label', 'P0100'], { TIM_MARKER_MAX_ROOT: dir });
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker).toMatchObject({ project: 'P0100', session: 's7', exchanges: 12, batch_size: 3, batches_summarized: 4 });
  });
});
