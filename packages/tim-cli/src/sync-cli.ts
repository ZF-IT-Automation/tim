// TIM sync CLI commands

import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TimStore } from 'tim-store';
import { getUnackedStaging } from 'tim-store';
import {
  TimSyncClient,
  SyncApiError,
  generateSalt,
  loadConfig,
  saveConfig,
  loadSyncState,
  saveSyncState,
  getDeviceId,
  defaultFileId,
  buildSyncContext,
  runPush,
  runPull,
  startDevServer,
} from 'tim-sync-client';
import { loadConfig as loadTimConfig, getTimDir } from 'tim-core';

function getDbPath(): string {
  const config = loadTimConfig();
  return process.env.TIM_DB_PATH || config.dbPath || `${process.env.HOME}/.tim/tim.db`;
}

function parseSyncArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = 'true';
      }
    }
  }
  return parsed;
}

async function promptHidden(rl: readline.Interface, label: string): Promise<string> {
  return rl.question(label);
}

export async function cmdSyncConnect(args: string[]): Promise<void> {
  const flags = parseSyncArgs(args);
  const rl = readline.createInterface({ input, output });

  try {
    const deviceId = getDeviceId();
    const fileId = defaultFileId(deviceId);

    const serverUrl = flags['server-url'] ?? (
      (await rl.question('Sync server URL [http://localhost:3100]: ')).trim()
      || 'http://localhost:3100'
    );

    const userId = flags['user-id']
      ?? (await rl.question('User ID: ')).trim();
    if (!userId) {
      console.error('User ID is required');
      process.exit(1);
    }

    const token = flags.token ?? userId;
    const passphrase = flags.passphrase
      ?? await promptHidden(rl, 'Passphrase: ');
    if (!passphrase) {
      console.error('Passphrase is required');
      process.exit(1);
    }

    const client = new TimSyncClient(serverUrl, token);
    const healthy = await client.health();
    if (!healthy) {
      console.error(`Cannot reach sync server at ${serverUrl}`);
      process.exit(1);
    }

    const salt = generateSalt();
    try {
      await client.createFile(fileId, salt);
    } catch (e) {
      if (e instanceof SyncApiError && e.code === 'CONFLICT') {
        const files = await client.listFiles();
        const existing = files.find((f) => f.id === fileId);
        if (!existing?.salt) {
          console.error('File exists but no salt returned — cannot decrypt');
          process.exit(1);
        }
        saveConfig({
          serverUrl,
          userId,
          token,
          salt: existing.salt,
          fileId,
        });
        console.log(`✓ Connected (existing file). File ID: ${fileId}`);
        return;
      }
      throw e;
    }

    saveConfig({ serverUrl, userId, token, salt, fileId });
    saveSyncState({ fileId, cursor: null, lastPush: null, lastPull: null });
    console.log(`✓ Connected. File ID: ${fileId}`);
  } finally {
    rl.close();
  }
}

function requirePassphrase(flags: Record<string, string>): string {
  const p = process.env.TIM_SYNC_PASSPHRASE ?? flags.passphrase;
  if (!p) {
    console.error('Set TIM_SYNC_PASSPHRASE or pass --passphrase');
    process.exit(1);
  }
  return p;
}

export async function cmdSyncPush(args: string[]): Promise<void> {
  const flags = parseSyncArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('Not connected. Run: tim sync connect');
    process.exit(1);
  }

  const passphrase = requirePassphrase(flags);
  const store = new TimStore(getDbPath());
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId());
    const { pushed, queued } = await runPush(ctx);
    console.log(`Pushed ${pushed} records${queued ? ' (more queued — retry push)' : ''}`);
  } finally {
    store.close();
  }
}

export async function cmdSyncPull(args: string[]): Promise<void> {
  const flags = parseSyncArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('Not connected. Run: tim sync connect');
    process.exit(1);
  }

  const passphrase = requirePassphrase(flags);
  const store = new TimStore(getDbPath());
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId());
    const { pulled, conflicts } = await runPull(ctx);
    console.log(`Pulled ${pulled} records, ${conflicts} conflicts`);
  } finally {
    store.close();
  }
}

export async function cmdSyncStatus(): Promise<void> {
  const config = loadConfig();
  const state = loadSyncState();
  const timDir = getTimDir();

  if (!config) {
    console.log('Sync: not configured (run tim sync connect)');
    return;
  }

  const client = new TimSyncClient(config.serverUrl, config.token);
  const healthy = await client.health();

  let unacked = 0;
  if (fs.existsSync(getDbPath())) {
    const store = new TimStore(getDbPath());
    try {
      unacked = getUnackedStaging(store.getDb()).length;
    } finally {
      store.close();
    }
  }

  console.log('═══ TIM Sync Status ═══');
  console.log(`Server: ${config.serverUrl} (${healthy ? '✓ reachable' : '✗ unreachable'})`);
  console.log(`User: ${config.userId}`);
  console.log(`File ID: ${config.fileId}`);
  console.log(`Device ID: ${getDeviceId()}`);
  console.log(`Unacked staging: ${unacked}`);
  console.log(`Last push: ${state?.lastPush ?? 'never'}`);
  console.log(`Last pull: ${state?.lastPull ?? 'never'}`);
  console.log(`Cursor: ${state?.cursor ?? '(none)'}`);
  console.log(`Config: ${timDir}/sync.json`);
}

export async function cmdSyncDev(args: string[]): Promise<void> {
  const flags = parseSyncArgs(args);
  const port = parseInt(flags.port ?? '3100', 10);
  startDevServer(port);
}

export async function cmdSync(sub: string | undefined, args: string[]): Promise<void> {
  switch (sub) {
    case 'connect':
      await cmdSyncConnect(args);
      break;
    case 'push':
      await cmdSyncPush(args);
      break;
    case 'pull':
      await cmdSyncPull(args);
      break;
    case 'status':
      await cmdSyncStatus();
      break;
    case 'dev':
      await cmdSyncDev(args);
      break;
    default:
      console.error(`Unknown sync command: ${sub ?? '(none)'}`);
      console.error('Usage: tim sync <connect|push|pull|status|dev> [options]');
      process.exit(1);
  }
}
