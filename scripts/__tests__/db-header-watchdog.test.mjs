import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../cron/tim-db-header-watchdog.sh');
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A 100-byte SQLite header; the script reads nothing else.
function run({ dbSize = 10, freelist = 0, cookie = 1 }) {
  const dir = mkdtempSync(join(tmpdir(), 'tim-header-'));
  dirs.push(dir);
  const header = Buffer.alloc(100);
  header.write('SQLite format 3\0', 0, 'latin1');
  header.writeUInt32BE(dbSize, 28);
  header.writeUInt32BE(freelist, 36);
  header.writeUInt32BE(cookie, 40);
  const file = join(dir, 'tim.db');
  writeFileSync(file, header);
  const r = spawnSync('bash', [script], { env: { ...process.env, HOME: dir, TIM_DB_PATH: file }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

describe('tim-db-header-watchdog', () => {
  it('accepts any schema cookie (old trigger churn left it at ~557k; a restore resets it to 1)', () => {
    expect(run({ cookie: 557851 }).code).toBe(0);
    expect(run({ cookie: 1 }).code).toBe(0);
  });

  it('alerts on the 2026-06-07 garbage pattern', () => {
    // Header values of the archived June sample.
    const r = run({ dbSize: 3216834560, freelist: 705167360, cookie: 65536 });
    expect(r.code).toBe(2);
    expect(r.out).toContain('CORRUPT:db_size_too_large');
  });
});
