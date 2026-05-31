import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TimConfig } from './index.js';

export interface HooksConfig {
  sessionStart?: string | string[];
  sessionEnd?: string | string[];
  enabled?: boolean;
  timeoutMs?: number;
}

export interface TimConfigFile extends TimConfig {
  hooks?: HooksConfig;
}

const DEFAULT_CONFIG: TimConfigFile = {
  dbPath: path.join(os.homedir(), '.tim', 'tim.db'),
  deviceId: '',
  hooks: {
    enabled: true,
    timeoutMs: 30_000,
  },
};

export function getTimDir(): string {
  return path.join(os.homedir(), '.tim');
}

export function getConfigPath(): string {
  return path.join(getTimDir(), 'config.json');
}

export function loadConfig(): TimConfigFile {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<TimConfigFile>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      hooks: {
        ...DEFAULT_CONFIG.hooks,
        ...raw.hooks,
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: TimConfigFile): void {
  const timDir = getTimDir();
  if (!fs.existsSync(timDir)) {
    fs.mkdirSync(timDir, { recursive: true });
  }
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export function normalizeHookScripts(scripts: string | string[] | undefined): string[] {
  if (!scripts) return [];
  return Array.isArray(scripts) ? scripts : [scripts];
}

export function hooksEnabled(config: TimConfigFile): boolean {
  return config.hooks?.enabled !== false;
}
