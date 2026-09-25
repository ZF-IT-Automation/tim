#!/usr/bin/env node
// Count live edges that share one (source_id, target_id, type).
// Opens a copy through TimStore readonly. Never opens the path you pass.

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/count-duplicate-edges.mjs <tim-db>');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const storeModule = pathToFileURL(path.join(here, '../packages/tim-store/dist/index.js')).href;
const { TimStore } = await import(storeModule);

const dir = mkdtempSync(path.join(tmpdir(), 'tim-edge-dupes-'));
const copyPath = path.join(dir, 'copy.db');
copyFileSync(source, copyPath);

const store = new TimStore(copyPath, { readonly: true });
try {
  const row = store.getDb().prepare(`
    SELECT COUNT(*) AS duplicate_groups
    FROM (
      SELECT 1
      FROM edges
      GROUP BY source_id, target_id, type
      HAVING COUNT(*) > 1
    )
  `).get();
  process.stdout.write(`${row.duplicate_groups}\n`);
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
