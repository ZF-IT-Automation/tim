import type { TimStore } from 'tim-store';
import { loadConfig, getDeviceId } from './config.js';
import { buildSyncContext, runPush, runPull } from './sync.js';

const syncCooldowns = new Map<string, number>();
const COOLDOWN_MS = 30_000;

let pushInFlight = false;
let pullInFlight = false;

function shouldSync(key: string, cooldownMs: number): boolean {
  const last = syncCooldowns.get(key) ?? 0;
  return Date.now() - last > cooldownMs;
}

function markSynced(key: string): void {
  syncCooldowns.set(key, Date.now());
}

/** @internal peek at cooldown timestamp for tests (0 = not armed) */
export function _peekCooldown(key: string): number {
  return syncCooldowns.get(key) ?? 0;
}

export interface AutoPushResult {
  ran: boolean;
  pushed?: number;
  queued?: boolean;
  reason?: string;
}

export async function autoPush(store: TimStore): Promise<AutoPushResult> {
  const passphrase = process.env.TIM_SYNC_PASSPHRASE;
  if (!passphrase) return { ran: false, reason: 'no-passphrase' };
  if (pushInFlight) return { ran: false, reason: 'in-flight' };
  if (!shouldSync('push', COOLDOWN_MS)) return { ran: false, reason: 'cooldown' };

  const config = loadConfig();
  if (!config) return { ran: false, reason: 'no-config' };

  pushInFlight = true;
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId());
    const result = await runPush(ctx);
    markSynced('push'); // ONLY arm cooldown on success
    return { ran: true, pushed: result.pushed, queued: result.queued };
  } catch (err) {
    console.error('[tim-sync] autoPush failed:', (err as Error).message);
    // do NOT markSynced — let next call retry immediately (gated by InFlight only)
    return { ran: true, reason: 'error' };
  } finally {
    pushInFlight = false;
  }
}

export interface AutoPullResult {
  ran: boolean;
  pulled?: number;
  conflicts?: number;
  reason?: string;
}

export async function autoPull(store: TimStore): Promise<AutoPullResult> {
  const passphrase = process.env.TIM_SYNC_PASSPHRASE;
  if (!passphrase) return { ran: false, reason: 'no-passphrase' };
  if (pullInFlight) return { ran: false, reason: 'in-flight' };
  if (!shouldSync('pull', COOLDOWN_MS)) return { ran: false, reason: 'cooldown' };

  const config = loadConfig();
  if (!config) return { ran: false, reason: 'no-config' };

  pullInFlight = true;
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId());
    const result = await runPull(ctx);
    markSynced('pull'); // ONLY arm cooldown on success
    return { ran: true, pulled: result.pulled, conflicts: result.conflicts };
  } catch (err) {
    console.error('[tim-sync] autoPull failed:', (err as Error).message);
    // do NOT markSynced — let next call retry immediately (gated by InFlight only)
    return { ran: true, reason: 'error' };
  } finally {
    pullInFlight = false;
  }
}

/** @internal reset cooldowns for tests */
export function resetSyncCooldowns(): void {
  syncCooldowns.clear();
  pushInFlight = false;
  pullInFlight = false;
}
