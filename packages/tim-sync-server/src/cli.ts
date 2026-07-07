#!/usr/bin/env node
import * as os from 'node:os';
import * as path from 'node:path';
import { startHostedSyncServer } from './server.js';

async function main(): Promise<void> {
  const port = parseInt(process.env.TIM_SYNC_PORT ?? process.argv[2] ?? '3100', 10);
  const dataDir = process.env.TIM_SYNC_DATA_DIR ?? path.join(os.homedir(), '.tim', 'sync-server');
  const handle = await startHostedSyncServer({ port, dataDir });
  console.log(`TIM hosted sync server on http://localhost:${handle.port} (data: ${dataDir})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
