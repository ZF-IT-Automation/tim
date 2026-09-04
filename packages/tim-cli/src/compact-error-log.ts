// TIM CLI — compact-error-log
//
// Rebuilds a bloated error_log (the 2026-09-03 EPIPE storm path) without a
// multi-million-row DELETE, then optionally VACUUMs. Requires exclusive
// maintenance, writer verification, and free-space preflight for VACUUM.

import * as fs from 'fs';
import * as path from 'path';
import { acquireMaintenanceLock } from 'tim-core';
import { parseArgs, valueOptionsFor } from './args.js';
import { compactErrorLog } from 'tim-store';
import { resolveDbPath, readFreeBytes } from './snapshot.js';
import { requireNoWriters } from './writers.js';

/** VACUUM may need roughly the current file size in free space. */
export const VACUUM_HEADROOM_FACTOR = 1.1;

/** Backup copy needs at least the current DB size in free space. */
export function backupHasRoom(dbBytes: number, freeBytes: number): boolean {
  return freeBytes >= dbBytes;
}

export function vacuumHasRoom(dbBytes: number, freeBytes: number): boolean {
  return freeBytes >= dbBytes * VACUUM_HEADROOM_FACTOR;
}

export function planCompactErrorLog(opts: {
  dbPath: string;
  maxEntries: number;
  vacuum: boolean;
  freeBytes?: number;
}): { ok: true; plan: string[] } | { ok: false; error: string } {
  const plan: string[] = [
    `acquire maintenance lock on ${opts.dbPath}`,
    'verify no tim-mcp writers',
    `backup ${opts.dbPath} before mutation`,
    `rebuild error_log keeping newest ${opts.maxEntries} rows`,
  ];
  if (opts.vacuum) {
    if (opts.freeBytes === undefined) {
      return { ok: false, error: 'freeBytes required for VACUUM preflight' };
    }
    const dbBytes = fs.statSync(opts.dbPath).size;
    if (!vacuumHasRoom(dbBytes, opts.freeBytes)) {
      return {
        ok: false,
        error: `insufficient free space for VACUUM (need ~${Math.ceil(dbBytes * VACUUM_HEADROOM_FACTOR)} bytes, have ${opts.freeBytes})`,
      };
    }
    plan.push(`VACUUM (${dbBytes} byte file)`);
  }
  return { ok: true, plan };
}

export async function cmdCompactErrorLog(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('compact-error-log') });
  const dbPath = flags.db || resolveDbPath();
  const dryRun = flags['dry-run'] === 'true';
  const vacuum = flags.vacuum === 'true';
  const maxEntriesRaw = flags['max-entries'] !== undefined ? Number(flags['max-entries']) : 10_000;
  const maxEntries = Number.isFinite(maxEntriesRaw) && maxEntriesRaw > 0 ? maxEntriesRaw : 10_000;

  if (!fs.existsSync(dbPath)) {
    console.error(`compact-error-log: db not found: ${dbPath}`);
    process.exit(1);
  }

  let freeBytes: number;
  try {
    freeBytes = readFreeBytes(path.dirname(dbPath));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`compact-error-log: cannot stat filesystem: ${message}`);
    process.exit(1);
  }

  const planned = planCompactErrorLog({ dbPath, maxEntries, vacuum, freeBytes });
  if (!planned.ok) {
    console.error(`compact-error-log: ${planned.error}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, db: dbPath, plan: planned.plan }));
    return;
  }

  const dbBytes = fs.statSync(dbPath).size;
  if (!backupHasRoom(dbBytes, freeBytes)) {
    console.error(
      `compact-error-log: insufficient free space for backup (need ${dbBytes} bytes, have ${freeBytes})`,
    );
    process.exit(1);
  }

  let maintenance: ReturnType<typeof acquireMaintenanceLock> | null = null;
  const backupPath = `${dbPath}.pre-compact-${Date.now()}`;

  try {
    maintenance = acquireMaintenanceLock({ dbPath, operation: 'compact-error-log' });

    try {
      requireNoWriters('compact-error-log');
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`compact-error-log: ${message}`);
      // process.exit() skips finally — lock self-heals via isMaintenanceActive().
      process.exit(1);
    }

    fs.copyFileSync(dbPath, backupPath);

    let Database: typeof import('better-sqlite3');
    try {
      Database = require('better-sqlite3');
    } catch (e: any) {
      console.error(`compact-error-log: better-sqlite3 not available: ${e.message}`);
      process.exit(1);
    }

    const db = new Database(dbPath);
    try {
      const result = compactErrorLog(db, { maxEntries, vacuum });
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }> | string;
      const check = Array.isArray(integrity) ? integrity[0]?.integrity_check : integrity;
      if (check !== 'ok') {
        throw new Error(`integrity_check failed after compaction: ${String(check)}`);
      }
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Wrapper script prunes *.pre-compact-* on failed runs; success should not leave a copy.
      }
      console.log(JSON.stringify({ ok: true, db: dbPath, ...result }));
    } catch (e: unknown) {
      db.close();
      try {
        fs.copyFileSync(backupPath, dbPath);
      } catch (restoreErr: unknown) {
        const message = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        console.error(`compact-error-log: rollback failed: ${message}`);
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error(`compact-error-log: ${message}`);
      // process.exit() skips finally — lock self-heals via isMaintenanceActive().
      process.exit(1);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } finally {
    maintenance?.release();
  }
}
