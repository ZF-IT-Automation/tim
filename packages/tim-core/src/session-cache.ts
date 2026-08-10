import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TimSessionCache {
  session_id: string;
  cwd: string;
  ts?: string;
}

export function timSessionCachePath(): string {
  const dir = process.env.TIM_CACHE_DIR?.trim() || path.join(os.homedir(), '.tim');
  return path.join(dir, '.session-cache');
}

/**
 * Hermes pre_llm_call cache (~/.tim/.session-cache).
 *
 * One global slot shared by every TIM consumer on the host — interactive
 * sessions, workers, cronjobs — and the last writer wins. `expectedCwd` is how
 * a caller checks the slot is its own: the entry is only returned when it names
 * the same directory. Without it the caller cannot tell whose session id it is
 * getting, so it gets none.
 */
export function readTimSessionCache(
  maxAgeMs = 3_600_000,
  expectedCwd?: string,
): TimSessionCache | null {
  const p = timSessionCachePath();
  if (!fs.existsSync(p)) return null;
  try {
    const stat = fs.statSync(p);
    if (maxAgeMs > 0 && Date.now() - stat.mtimeMs > maxAgeMs) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const session_id =
      typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
    if (!session_id) return null;
    const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
    if (expectedCwd !== undefined) {
      // Exact match, the same rule resolveCurrentSession uses to pick a session
      // by cwd. Prefix matching would accept the writer's `cwd: $HOME` fallback
      // as an ancestor of every caller on the host.
      if (!cwd || path.resolve(cwd) !== path.resolve(expectedCwd)) return null;
    }
    const ts = typeof raw.ts === 'string' ? raw.ts : undefined;
    return { session_id, cwd, ts };
  } catch {
    return null;
  }
}

/** Active harness session id for MCP / statusline. */
export function resolveActiveSessionId(options: {
  sessionIdArg?: string;
  envSessionId?: string;
  markerSession?: string;
  cacheMaxAgeMs?: number;
  /** Caller's working directory. Without it the session cache is skipped — see readTimSessionCache. */
  cwd?: string;
  /** Set false in daemon/HTTP contexts — the cache file is per-machine, not per-client. */
  useSessionCache?: boolean;
  /** Set false in daemon/HTTP contexts — env is daemon-global. */
  useEnv?: boolean;
}): string | undefined {
  const fromArg = options.sessionIdArg?.trim();
  if (fromArg) return fromArg;

  if (options.useEnv !== false) {
    const fromEnv =
      options.envSessionId?.trim() || process.env.TIM_SESSION_ID?.trim();
    if (fromEnv) return fromEnv;
  }

  if (options.useSessionCache !== false && options.cwd !== undefined) {
    const cached = readTimSessionCache(options.cacheMaxAgeMs, options.cwd);
    if (cached?.session_id) return cached.session_id;
  }

  const fromMarker = options.markerSession?.trim();
  if (fromMarker) return fromMarker;

  return undefined;
}
