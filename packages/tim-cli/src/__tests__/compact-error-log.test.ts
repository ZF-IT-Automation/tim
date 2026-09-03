import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planCompactErrorLog, vacuumHasRoom } from '../compact-error-log.js';

describe('planCompactErrorLog', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tim-compact-plan-')), 'tim.db');
    fs.writeFileSync(dbPath, Buffer.alloc(2_000_000_000));
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('requires free space before VACUUM', () => {
    const result = planCompactErrorLog({
      dbPath,
      maxEntries: 10_000,
      vacuum: true,
      freeBytes: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/insufficient free space/i);
  });

  it('dry-run plan lists maintenance steps', () => {
    const result = planCompactErrorLog({
      dbPath: '/tmp/tim.db',
      maxEntries: 5000,
      vacuum: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.some((s) => s.includes('maintenance'))).toBe(true);
      expect(result.plan.some((s) => s.includes('5000'))).toBe(true);
    }
  });
});

describe('vacuumHasRoom', () => {
  it('requires headroom proportional to db size', () => {
    expect(vacuumHasRoom(1_000_000_000, 500_000_000)).toBe(false);
    expect(vacuumHasRoom(1_000_000_000, 1_200_000_000)).toBe(true);
  });
});
