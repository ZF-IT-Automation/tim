#!/usr/bin/env node
/**
 * One-shot migration: coerce legacy boolean metadata (1/0/"true"/"false") to real JSON booleans.
 *
 * Usage:
 *   node scripts/reconcile-metadata-types.mjs [--db /path/to/tim.db] [--dry-run]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TimStore } from '../packages/tim-store/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDb = path.join(process.env.HOME ?? '', '.tim', 'tim.db');

function parseArgs(argv) {
  let dbPath = defaultDb;
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--db') {
      dbPath = argv[++i];
      if (!dbPath) {
        console.error('--db requires a path');
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/reconcile-metadata-types.mjs [--db PATH] [--dry-run]`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return { dbPath, dryRun };
}

async function main() {
  const { dbPath, dryRun } = parseArgs(process.argv);
  const store = new TimStore(dbPath);

  try {
    const found = store.findEntriesWithNonBooleanTask();
    console.log(`DB: ${dbPath}`);
    console.log(`Mode: ${dryRun ? 'dry-run' : 'write'}`);
    console.log(`Found ${found.length} entries with non-boolean metadata primitives`);

    if (dryRun && found.length > 0) {
      for (const row of found.slice(0, 10)) {
        console.log(`  would update ${row.id}: ${row.metadata}`);
      }
      if (found.length > 10) {
        console.log(`  … and ${found.length - 10} more`);
      }
    }

    const result = await store.reconcileMetadataTypes({ dryRun });
    console.log(`Summary: found=${result.found} updated=${result.updated} skipped=${result.skipped}`);

    const remaining = store.findEntriesWithNonBooleanTask();
    console.log(`Remaining after run: ${remaining.length}`);
  } finally {
    store.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
