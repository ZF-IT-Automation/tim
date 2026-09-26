// TIM sync CLI commands

import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TimStore } from 'tim-store';
import {
  TimSyncClient,
  SyncApiError,
  generateSalt,
  saveConfig,
  clearSyncConnection,
  getDeviceId,
  defaultFileId,
  buildSyncContext,
  runPush,
  runPull,
  runSyncOwner,
  syncCycleExitCode,
  thrownSyncExitCode,
  resolveSecretPassphrase,
  MissingSecretPassphraseError,
  startDevServer,
  readSyncConfig,
  saveSyncState,
  describeSyncConfigStatus,
  canonicalDbIdentity,
  freshBoundSyncState,
  readSyncStateFile,
  repairSyncState,
  collectSyncAudit,
  SyncStateRejectedError,
  SyncLockBusyError,
  classifySyncStateFile,
  bindingFor,
} from 'tim-sync-client';
import { loadConfig as loadTimConfig, getTimDir } from 'tim-core';
import { parseArgs, valueOptionsFor } from './args.js';

function getDbPath(): string {
  const config = loadTimConfig();
  return process.env.TIM_DB_PATH || config.dbPath || `${process.env.HOME}/.tim/tim.db`;
}

async function promptHidden(rl: readline.Interface, label: string): Promise<string> {
  return rl.question(label);
}

export async function cmdSyncConnect(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('sync', 'connect') });
  const rl = readline.createInterface({ input, output });

  try {
    const deviceId = getDeviceId();
    const fileId = defaultFileId(deviceId);

    const serverUrl = flags['server-url'] ?? (
      (await rl.question('Sync server URL [http://localhost:3100]: ')).trim()
      || 'http://localhost:3100'
    );

    const clientProbe = new TimSyncClient(serverUrl, '');
    const healthy = await clientProbe.health();
    if (!healthy) {
      console.error(`Cannot reach sync server at ${serverUrl}`);
      process.exit(1);
    }

    let userId = flags['user-id']?.trim() ?? '';
    let token = flags.token?.trim() ?? '';

    if (flags.register === 'true' || (!token && !flags['user-id'])) {
      const tier = flags.tier === 'pro' ? 'pro' : 'free';
      const reg = await clientProbe.register(tier);
      token = reg.token;
      userId = reg.tenant_id;
      console.log(`✓ Registered tenant ${userId} (${reg.tier})`);
    } else {
      if (!userId) {
        userId = (await rl.question('User ID: ')).trim();
      }
      if (!userId) {
        console.error('User ID is required (or use --register)');
        process.exit(1);
      }
      if (!token) token = userId;
    }

    const passphrase = flags.passphrase
      ?? await promptHidden(rl, 'Passphrase: ');
    if (!passphrase) {
      console.error('Passphrase is required');
      process.exit(1);
    }

    const client = new TimSyncClient(serverUrl, token);

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
        noteUnboundSyncState();
        console.log(`✓ Connected (existing file). File ID: ${fileId}`);
        return;
      }
      throw e;
    }

    saveConfig({ serverUrl, userId, token, salt, fileId });
    noteUnboundSyncState();
    console.log(`✓ Connected. File ID: ${fileId}`);
  } finally {
    rl.close();
  }
}

function noteUnboundSyncState(): void {
  const config = readSyncConfig().config;
  const dbIdentity = canonicalDbIdentity(getDbPath());
  const existing = readSyncStateFile();
  if (existing.kind === 'missing' && config && dbIdentity) {
    saveSyncState(freshBoundSyncState(config, dbIdentity));
    return;
  }
  if (existing.kind !== 'missing') {
    console.log('Existing sync state was left unchanged. Run `tim sync repair` before push or pull if it is not bound to this database.');
  }
}

function cycleDeadline(flags: Record<string, string>): number {
  const raw = flags.deadline;
  const ms = raw === undefined ? 60_000 : Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    console.error('--deadline must be a non-negative number of milliseconds');
    process.exit(1);
  }
  return Date.now() + ms;
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
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('sync', 'push') });
  const configRead = readSyncConfig();
  const config = configRead.config;
  if (!config) {
    console.error(describeSyncConfigStatus(configRead.status));
    process.exit(1);
  }

  const passphrase = requirePassphrase(flags);
  const secretPassphrase = resolveSecretPassphrase(flags);
  const store = new TimStore(getDbPath());
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId(), secretPassphrase);
    const result = await runPush(ctx, { deadlineAt: cycleDeadline(flags) });
    if (result.oversized.length > 0) {
      console.error(`Oversized records parked: ${result.oversized.map((row) => `${row.key}#${row.revision}`).join(', ')}`);
    }
    console.log(`Pushed ${result.pushed} records${result.queued ? ' (more queued — retry push)' : ''}`);
    const code = syncCycleExitCode(result);
    if (code !== 0) process.exit(code);
  } catch (err) {
    if (err instanceof MissingSecretPassphraseError || err instanceof SyncStateRejectedError || err instanceof SyncApiError || err instanceof SyncLockBusyError) {
      console.error(err.message);
      process.exit(thrownSyncExitCode(err));
    }
    throw err;
  } finally {
    store.close();
  }
}

export async function cmdSyncPull(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('sync', 'pull') });
  const configRead = readSyncConfig();
  const config = configRead.config;
  if (!config) {
    console.error(describeSyncConfigStatus(configRead.status));
    process.exit(1);
  }

  const passphrase = requirePassphrase(flags);
  const secretPassphrase = resolveSecretPassphrase(flags);
  const store = new TimStore(getDbPath());
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId(), secretPassphrase);
    const { pulled, conflicts } = await runPull(ctx, { deadlineAt: cycleDeadline(flags) });
    console.log(`Pulled ${pulled} records, ${conflicts} conflicts`);
  } catch (err) {
    if (err instanceof SyncStateRejectedError || err instanceof SyncApiError || err instanceof SyncLockBusyError) {
      console.error(err.message);
      process.exit(thrownSyncExitCode(err));
    }
    throw err;
  } finally {
    store.close();
  }
}

export async function cmdSyncOwner(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('sync', 'owner') });
  const configRead = readSyncConfig();
  const config = configRead.config;
  if (!config) {
    console.error(describeSyncConfigStatus(configRead.status));
    process.exit(1);
  }
  const passphrase = requirePassphrase(flags);
  const secretPassphrase = resolveSecretPassphrase(flags);
  const intervalMs = flags.interval === undefined ? undefined : Number(flags.interval);
  const deadlineMs = flags.deadline === undefined ? undefined : Number(flags.deadline);
  if ((intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs < 0))
    || (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs < 0))) {
    console.error('--interval and --deadline must be non-negative milliseconds');
    process.exit(1);
  }
  const store = new TimStore(getDbPath());
  try {
    const result = await runSyncOwner({
      store,
      config,
      passphrase,
      secretPassphrase,
      once: flags.once === 'true',
      intervalMs,
      deadlineMs,
    });
    if (result.alreadyOwned) {
      console.log('Sync owner already running');
      return;
    }
    if (result.push) {
      if (result.push.oversized.length > 0) {
        console.error(`Oversized records parked: ${result.push.oversized.map((row) => `${row.key}#${row.revision}`).join(', ')}`);
      }
      console.log(`Pushed ${result.push.pushed} records${result.push.queued ? ' (more queued — retry push)' : ''}`);
    }
    if (result.pull) {
      console.log(`Pulled ${result.pull.pulled} records, ${result.pull.conflicts} conflicts`);
    }
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } finally {
    store.close();
  }
}

export async function cmdSyncStatus(): Promise<void> {
  const configRead = readSyncConfig();
  const config = configRead.config;
  const timDir = getTimDir();

  if (!config) {
    console.log(`Sync: ${describeSyncConfigStatus(configRead.status)}`);
    return;
  }

  const dbIdentity = canonicalDbIdentity(getDbPath());
  const state = classifySyncStateFile(dbIdentity ? bindingFor(config, dbIdentity) : null);

  const client = new TimSyncClient(config.serverUrl, config.token);
  const healthy = await client.health();
  let remoteStatus: { tier?: string; entry_count?: number; total_bytes?: number } = {};
  try {
    remoteStatus = await client.syncStatus();
  } catch {
    /* legacy dev server may not expose /sync/status */
  }

  let unacked = 0;
  if (fs.existsSync(getDbPath())) {
    const store = new TimStore(getDbPath(), { readonly: true });
    try {
      unacked = (store.getDb().prepare(
        'SELECT COUNT(*) AS count FROM staging WHERE acked = 0',
      ).get() as { count: number }).count;
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
  console.log(`State: ${state.status}`);
  console.log(`Last push success: ${state.lastPushSuccess ?? 'never'}`);
  console.log(`Last pull success: ${state.lastPullSuccess ?? 'never'}`);
  console.log(`Last push attempt: ${state.lastPushAttempt ?? 'never'}`);
  console.log(`Last pull attempt: ${state.lastPullAttempt ?? 'never'}`);
  console.log(`Last push error: ${state.lastPushError ?? '(none)'}`);
  console.log(`Last pull error: ${state.lastPullError ?? '(none)'}`);
  console.log(`Cursor: ${state.cursorUsable ? 'usable' : `unavailable (${state.status})`}`);
  console.log(`Config: ${timDir}/sync.json`);
  if (remoteStatus.tier) {
    console.log(`Tier: ${remoteStatus.tier}`);
    console.log(`Remote entries: ${remoteStatus.entry_count ?? 0}`);
    console.log(`Remote bytes: ${remoteStatus.total_bytes ?? 0}`);
  }
}

export function cmdSyncDisconnect(): void {
  const removed = clearSyncConnection();
  if (removed.config || removed.state) {
    const parts: string[] = [];
    if (removed.config) parts.push('sync.json');
    if (removed.state) parts.push('sync-state.json');
    console.log(`✓ Disconnected — removed ${parts.join(' and ')}`);
  } else {
    console.log('Sync: not configured');
  }
}

export function cmdSyncAudit(args: string[]): void {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('sync', 'audit') });
  if (flags.json !== 'true') {
    console.error('Usage: tim sync audit --json');
    process.exit(1);
  }
  const report = collectSyncAudit(getDbPath());
  console.log(JSON.stringify(report));
}

export function cmdSyncRepair(): void {
  const dbIdentity = canonicalDbIdentity(getDbPath());
  if (!dbIdentity) {
    console.error('Sync repair needs an existing database. Refusing to create one.');
    process.exit(1);
  }
  try {
    const result = repairSyncState(dbIdentity);
    if (result.action === 'unchanged') {
      console.log('Sync state already matches this database, server, tenant, file, and protocol generation.');
      return;
    }
    if (result.action === 'created') {
      console.log('Sync state created with a null cursor.');
      return;
    }
    console.log(`Sync state archived at ${result.preservedPath}`);
    console.log('New state has a null cursor. The archived file was not applied.');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export async function cmdSyncDev(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('sync', 'dev') });
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
    case 'owner':
      await cmdSyncOwner(args);
      break;
    case 'status':
      await cmdSyncStatus();
      break;
    case 'disconnect':
      cmdSyncDisconnect();
      break;
    case 'audit':
      cmdSyncAudit(args);
      break;
    case 'repair':
      cmdSyncRepair();
      break;
    case 'dev':
      await cmdSyncDev(args);
      break;
    default:
      console.error(`Unknown sync command: ${sub ?? '(none)'}`);
      console.error('Usage: tim sync <connect|disconnect|push|pull|owner|status|audit|repair|dev> [options]');
      process.exit(1);
  }
}
