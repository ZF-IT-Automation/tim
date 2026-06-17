#!/usr/bin/env node
/**
 * Backfill session-summary-root content from existing batch-summary children.
 *
 * Usage:
 *   npx tsx scripts/backfill-session-summaries.ts [--db /path/to/tim.db] [--dry-run]
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDb = path.join(process.env.HOME ?? '', '.tim', 'tim.db');

function parseArgs(argv: string[]): { dbPath: string; dryRun: boolean } {
  let dbPath = defaultDb;
  let dryRun = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--db') {
      dbPath = argv[++i] ?? '';
      if (!dbPath) {
        console.error('--db requires a path');
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npx tsx scripts/backfill-session-summaries.ts [--db PATH] [--dry-run]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return { dbPath, dryRun };
}

async function main(): Promise<void> {
  const { dbPath, dryRun } = parseArgs(process.argv);
  const storeMod = await import(pathToFileURL(path.join(__dirname, '../packages/tim-store/dist/index.js')).href);
  const { TimStore, SessionManager, foldBatchSummaries } = storeMod as typeof import('../packages/tim-store/dist/index.js');

  const store = new TimStore(dbPath);
  const sessions = new SessionManager(store);

  try {
    const summaryRoots = await store.getByMetadataKind('session-summary-root', 10_000);
    const toFix: Array<{ sessionId: string; summaryRootId: string; batchCount: number }> = [];

    for (const root of summaryRoots) {
      const content = root.content ?? '';
      if (content.trim() !== '') continue;

      const sessionId = root.parent_id;
      if (!sessionId) continue;

      const batches = await store.getChildByKind(root.id, 'batch-summary');
      const withContent = batches.filter(b => (b.content ?? '').trim() !== '');
      if (withContent.length === 0) continue;

      toFix.push({ sessionId, summaryRootId: root.id, batchCount: withContent.length });
    }

    console.log(`DB: ${dbPath}`);
    console.log(`Mode: ${dryRun ? 'dry-run' : 'write'}`);
    console.log(`Found ${toFix.length} session-summary-root nodes to backfill`);

    if (dryRun) {
      for (const row of toFix) {
        console.log(`  would rollup session=${row.sessionId} summaryRoot=${row.summaryRootId} batches=${row.batchCount}`);
      }
      return;
    }

    const rolled: string[] = [];
    for (const row of toFix) {
      await sessions.rollUpSession(row.sessionId, async batches => foldBatchSummaries(batches));
      rolled.push(row.sessionId);
      console.log(`  rolled up session=${row.sessionId} (${row.batchCount} batches)`);
    }

    console.log(`Done: ${rolled.length} sessions updated`);
    if (rolled.length > 0) {
      console.log(`IDs: ${rolled.join(', ')}`);
    }
  } finally {
    store.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
