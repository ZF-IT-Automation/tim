import * as fs from 'fs';
import * as path from 'path';
import { getConfigPath, getTimDir, loadConfig, saveConfig } from 'tim-core';
import { TimStore } from 'tim-store';

export interface AutoInitResult {
  ok: boolean;
  dbCreated: boolean;
  configCreated: boolean;
  error?: string;
}

/**
 * Zero-config bootstrap: create DB + default config on first connect.
 * Never throws — server must start even when init fails.
 */
export async function runAutoInit(options?: { dbPath?: string }): Promise<AutoInitResult> {
  const result: AutoInitResult = {
    ok: true,
    dbCreated: false,
    configCreated: false,
  };

  const config = loadConfig();
  const dbPath = options?.dbPath ?? config.dbPath;
  if (!dbPath) {
    result.ok = false;
    result.error = 'no dbPath configured';
    return result;
  }

  try {
    const dbExisted = fs.existsSync(dbPath);
    if (!dbExisted) {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const store = new TimStore(dbPath);
    if (!dbExisted) {
      result.dbCreated = true;
    }

    const agents = await store.getAgents();
    if (!agents.some(a => a.label === 'default')) {
      try {
        await store.registerAgent('Default Agent', 'default');
      } catch {
        // Race: another connect may have registered concurrently.
      }
    }
    store.close();

    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      const timDir = getTimDir();
      if (!fs.existsSync(timDir)) {
        fs.mkdirSync(timDir, { recursive: true });
      }
      saveConfig(loadConfig());
      result.configCreated = true;
    }
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}
