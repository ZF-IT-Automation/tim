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

export async function autoPush(store: TimStore): Promise<void> {
  const passphrase = process.env.TIM_SYNC_PASSPHRASE;
  if (!passphrase || !shouldSync('push', COOLDOWN_MS) || pushInFlight) return;

  const config = loadConfig();
  if (!config) return;

  markSynced('push');
  pushInFlight = true;
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId());
    await runPush(ctx);
  } catch (err) {
    console.error('[tim-sync] autoPush failed:', (err as Error).message);
  } finally {
    pushInFlight = false;
  }
}

export async function autoPull(store: TimStore): Promise<void> {
  const passphrase = process.env.TIM_SYNC_PASSPHRASE;
  if (!passphrase || !shouldSync('pull', COOLDOWN_MS) || pullInFlight) return;

  const config = loadConfig();
  if (!config) return;

  markSynced('pull');
  pullInFlight = true;
  try {
    const ctx = buildSyncContext(store, config, passphrase, getDeviceId());
    await runPull(ctx);
  } catch (err) {
    console.error('[tim-sync] autoPull failed:', (err as Error).message);
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
