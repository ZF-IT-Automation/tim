import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(__dirname, '../../dist/cli.js');

describe('migrate-schema worker guard', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevWorker: string | undefined;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-migrate-guard-'));
    prevHome = process.env.HOME;
    prevWorker = process.env.TEAMUP_WORKER;
    prevDbPath = process.env.TIM_DB_PATH;
    process.env.HOME = tmpHome;
    const init = spawnSync('node', [CLI, 'init'], {
      env: { ...process.env, HOME: tmpHome },
      encoding: 'utf8',
    });
    expect(init.status).toBe(0);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevWorker === undefined) delete process.env.TEAMUP_WORKER;
    else process.env.TEAMUP_WORKER = prevWorker;
    if (prevDbPath === undefined) delete process.env.TIM_DB_PATH;
    else process.env.TIM_DB_PATH = prevDbPath;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('refuses default live DB when TEAMUP_WORKER=1', () => {
    process.env.TEAMUP_WORKER = '1';
    delete process.env.TIM_DB_PATH;

    const result = spawnSync('node', [CLI, 'migrate-schema'], {
      env: { ...process.env, HOME: tmpHome },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing to migrate the live TIM database/);
    expect(result.stderr).toMatch(/TEAMUP_WORKER/);
  });

  it('allows migrate-schema on a copy when TEAMUP_WORKER=1', () => {
    const copyDb = path.join(tmpHome, 'worker-copy.db');
    fs.copyFileSync(path.join(tmpHome, '.tim', 'tim.db'), copyDb);

    const result = spawnSync('node', [CLI, 'migrate-schema'], {
      env: {
        ...process.env,
        HOME: tmpHome,
        TEAMUP_WORKER: '1',
        TIM_DB_PATH: copyDb,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Refusing to migrate the live TIM database/);
  });
});
