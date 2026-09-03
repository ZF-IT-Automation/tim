// TIM CLI — compact-error-log
//
// Rebuilds a bloated error_log (the 2026-09-03 EPIPE storm path) without a
// multi-million-row DELETE, then optionally VACUUMs. Refuses while any
// tim-mcp writer still holds the database.

import { parseArgs, valueOptionsFor } from './args.js';
import { compactErrorLog } from 'tim-store';
import { resolveDbPath } from './snapshot.js';
import { listTimMcpWriterPids, walSidecarsMayBeDropped } from './restore.js';

export async function cmdCompactErrorLog(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('compact-error-log') });
  const dbPath = flags.db || resolveDbPath();
  const leftover = listTimMcpWriterPids();
  if (!walSidecarsMayBeDropped(leftover)) {
    console.error(
      `compact-error-log: writers still hold the DB: ${leftover.join(' ')}\n` +
        `stop MCP first (scripts/tim-mcp-stop.sh or scripts/tim-compact-error-log.sh).`,
    );
    process.exit(1);
  }

  let Database: typeof import('better-sqlite3');
  try {
    Database = require('better-sqlite3');
  } catch (e: any) {
    console.error(`compact-error-log: better-sqlite3 not available: ${e.message}`);
    process.exit(1);
  }

  const maxEntries = flags['max-entries'] !== undefined ? Number(flags['max-entries']) : 10_000;
  const db = new Database(dbPath);
  try {
    const result = compactErrorLog(db, {
      maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 10_000,
      vacuum: flags.vacuum === 'true',
    });
    console.log(JSON.stringify({ ok: true, db: dbPath, ...result }));
  } finally {
    db.close();
  }
}
