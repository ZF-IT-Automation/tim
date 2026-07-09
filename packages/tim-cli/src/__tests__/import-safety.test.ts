import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const TEST_ROOT = path.join(os.tmpdir(), 'tim-cli-import-safety-tests');

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

describe('tim CLI import safety', () => {
  let homeDir: string;
  let dbPath: string;
  let sourcePath: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    homeDir = fs.mkdtempSync(path.join(TEST_ROOT, 'home-'));
    dbPath = path.join(homeDir, 'tim.db');
    sourcePath = path.join(homeDir, 'sample.hmem');
    fs.writeFileSync(sourcePath, '# sample');
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('refuses live import without snapshot acknowledgement', () => {
    const result = run(['import', sourcePath], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing live import without snapshot acknowledgement.');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('refuses repair-flags import without snapshot acknowledgement', () => {
    const result = run(['import', sourcePath, '--repair-flags'], {
      HOME: homeDir,
      TIM_DB_PATH: dbPath,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing live import without snapshot acknowledgement.');
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
