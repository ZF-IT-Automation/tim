import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTimDir } from 'tim-core';

export interface SyncConfig {
  serverUrl: string;
  userId: string;
  token: string;
  salt: string;
  fileId: string;
}

export interface SyncState {
  fileId: string;
  cursor: string | null;
  lastPush: string | null;
  lastPull: string | null;
}

export function getSyncConfigPath(): string {
  return path.join(getTimDir(), 'sync.json');
}

export function getSyncStatePath(): string {
  return path.join(getTimDir(), 'sync-state.json');
}

export function getDeviceIdPath(): string {
  return path.join(getTimDir(), 'device-id');
}

export function getQueuePath(fileId: string): string {
  return path.join(getTimDir(), `${fileId}.queue.json`);
}

export function loadConfig(): SyncConfig | null {
  const p = getSyncConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SyncConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: SyncConfig): void {
  const dir = getTimDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getSyncConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearConfig(): boolean {
  const p = getSyncConfigPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function clearSyncState(): boolean {
  const p = getSyncStatePath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function clearSyncConnection(): { config: boolean; state: boolean } {
  return {
    config: clearConfig(),
    state: clearSyncState(),
  };
}

export function loadSyncState(): SyncState | null {
  const p = getSyncStatePath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SyncState;
  } catch {
    return null;
  }
}

export function saveSyncState(state: SyncState): void {
  const dir = getTimDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getSyncStatePath(), JSON.stringify(state, null, 2));
}

export function getDeviceId(): string {
  const p = getDeviceIdPath();
  if (fs.existsSync(p)) {
    const id = fs.readFileSync(p, 'utf8').trim();
    if (id) return id;
  }
  const dir = getTimDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  fs.writeFileSync(p, id, { mode: 0o600 });
  return id;
}

export function defaultFileId(deviceId?: string): string {
  return `tim-${deviceId ?? getDeviceId()}`;
}
