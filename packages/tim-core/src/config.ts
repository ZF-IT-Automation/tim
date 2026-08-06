import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TimConfig } from './index.js';

export interface HooksConfig {
  sessionStart?: string | string[];
  sessionEnd?: string | string[];
  enabled?: boolean;
  timeoutMs?: number;
  promptSubmit?: {
    enabled?: boolean;
  };
}

export interface RememberConfig {
  enabled?: boolean;
  chain?: Array<{ cli: string; model: string; provider?: string }>;
  timeout_sec?: number;
  hard_timeout_ms?: number;
  maxCandidates?: number;
  topK?: number;
  minConfidence?: number;
  includeBatchSummaries?: boolean;
  searchType?: 'fts';
}

export interface TimConfigFile extends TimConfig {
  hooks?: HooksConfig;
  remember?: RememberConfig;
}

const DEFAULT_REMEMBER_CHAIN: NonNullable<RememberConfig['chain']> = [
  { cli: 'opencode', model: 'claude-3-5-haiku', provider: 'anthropic' },
  { cli: 'opencode', model: 'deepseek-v4-pro', provider: 'deepseek' },
  { cli: 'opencode', model: 'kimi', provider: 'moonshot' },
];

/** Same shape/providers as the remember chain — the summarizer falls through it in order. */
const DEFAULT_SUMMARIZER_CHAIN: NonNullable<TimConfigFile['summarizer']>['chain'] = [
  { cli: 'opencode', model: 'claude-3-5-haiku', provider: 'anthropic' },
  { cli: 'opencode', model: 'deepseek-v4-pro', provider: 'deepseek' },
  { cli: 'opencode', model: 'kimi', provider: 'moonshot' },
];

const DEFAULT_CONFIG: TimConfigFile = {
  dbPath: path.join(os.homedir(), '.tim', 'tim.db'),
  deviceId: '',
  hooks: {
    enabled: true,
    timeoutMs: 30_000,
  },
  batch_size: 5,
  projectSummary: {
    sessions_threshold: 5,
  },
  summarizer: {
    chain: DEFAULT_SUMMARIZER_CHAIN,
    timeout_sec: 600,
  },
  remember: {
    enabled: true,
    chain: DEFAULT_REMEMBER_CHAIN,
    timeout_sec: 5,
    hard_timeout_ms: 8000,
    maxCandidates: 30,
    topK: 5,
    minConfidence: 0.3,
    includeBatchSummaries: true,
    searchType: 'fts',
  },
  checkpoint: {
    everyN: 20,
  },
  briefing: {
    maxTokens: 9000,
    recentSessions: 5,
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
      summarizer: {
        ...DEFAULT_CONFIG.summarizer,
        ...raw.summarizer,
        // A user-supplied chain replaces the default wholesale — never merged element-wise.
        chain: raw.summarizer?.chain ?? DEFAULT_SUMMARIZER_CHAIN,
      },
      remember: {
        ...DEFAULT_CONFIG.remember,
        ...raw.remember,
        chain: raw.remember?.chain ?? DEFAULT_CONFIG.remember?.chain,
      },
      checkpoint: {
        ...DEFAULT_CONFIG.checkpoint,
        ...raw.checkpoint,
      },
      briefing: {
        ...DEFAULT_CONFIG.briefing,
        ...raw.briefing,
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
