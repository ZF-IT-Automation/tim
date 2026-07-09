import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = path.join(os.tmpdir(), 'tim-cli-help-tests');

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('tim CLI help safety', () => {
  let homeDir: string;
  let dbPath: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    homeDir = fs.mkdtempSync(path.join(TEST_ROOT, 'home-'));
    dbPath = path.join(homeDir, 'tim.db');
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('init --help does not initialize the database', () => {
    const result = run(['init', '--help'], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: tim init');
    expect(fs.existsSync(path.join(homeDir, '.tim'))).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('doctor --help does not open or create the database', () => {
    const result = run(['doctor', '--help'], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: tim doctor');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('stats --help does not open or create the database', () => {
    const result = run(['stats', '--help'], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: tim stats');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('release-check --help does not open or create the database', () => {
    const result = run(['release-check', '--help'], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: tim release-check');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('import --help does not open or create the database', () => {
    const result = run(['import', '--help'], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: tim import');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('setup-agent --help does not open or create the database', () => {
    const result = run(['setup-agent', '--help'], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: tim setup-agent');
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
