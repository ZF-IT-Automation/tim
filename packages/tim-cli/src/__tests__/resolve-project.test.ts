import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    dir = fs.mkdtempSync(path.join(TEST_ROOT, 'cli-'));
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

  it('resolve-project --format directive contains the load instruction', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ project: 'P0063', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
    const out = run(['resolve-project', '--cwd', dir, '--format', 'directive'], { TIM_MARKER_MAX_ROOT: dir });
    expect(out).toContain('tim_load_project(label="P0063")');
  });

  it('bind-project writes a marker; resolve-project reads it back', () => {
    run(['bind-project', '--cwd', dir, '--label', 'P0099'], { TIM_MARKER_MAX_ROOT: dir });
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker.project).toBe('P0099');
    expect(run(['resolve-project', '--cwd', dir], { TIM_MARKER_MAX_ROOT: dir }).trim()).toBe('P0099');
  });

  it('bind-project preserves existing counters, only changes project', () => {
    fs.writeFileSync(path.join(dir, '.tim-project'),
      JSON.stringify({ project: 'OLD', session: 's7', exchanges: 12, batch_size: 3, batches_summarized: 4 }));
    run(['bind-project', '--cwd', dir, '--label', 'P0100'], { TIM_MARKER_MAX_ROOT: dir });
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
    expect(marker).toMatchObject({ project: 'P0100', session: 's7', exchanges: 12, batch_size: 3, batches_summarized: 4 });
  });
});
