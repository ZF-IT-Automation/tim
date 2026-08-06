// `tim viewer` — local, read-only browser UI over the entry tree.

import { loadConfig, type TimConfigFile } from 'tim-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseArgs, valueOptionsFor } from './args.js';
import { NonLoopbackBindError, startViewer } from './viewer-server.js';

const DEFAULT_PORT = 7373;

function getDbPath(config: TimConfigFile): string {
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

export async function cmdViewer(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('viewer') });
  const dbPath = flags.db || getDbPath(loadConfig());
  const host = flags.host || '127.0.0.1';
  const showSecrets = flags['show-secrets'] === 'true';

  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port "${flags.port}" (expected 0-65535)`);
    process.exit(1);
  }

  // The store opens read-only with fileMustExist — report the missing file
  // ourselves rather than surfacing a raw SQLite error.
  if (!fs.existsSync(dbPath)) {
    console.error(`TIM database not found: ${dbPath}\nRun 'tim init' first, or pass --db <path>.`);
    process.exit(1);
  }

  let handle;
  try {
    handle = await startViewer({ dbPath, port, host, showSecrets });
  } catch (err) {
    if (err instanceof NonLoopbackBindError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  console.log(`TIM viewer (read-only) → ${handle.url}`);
  console.log(`  database: ${dbPath}`);
  console.log(
    showSecrets
      ? '  secrets:  SHOWN — secret-marked subtrees render in full'
      : '  secrets:  redacted (structure only) — pass --show-secrets to render them',
  );
  console.log('  Ctrl-C to stop.');

  const stop = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
