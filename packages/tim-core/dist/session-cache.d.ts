export interface TimSessionCache {
    session_id: string;
    cwd: string;
    ts?: string;
}
export declare function timSessionCachePath(): string;
/**
 * Hermes pre_llm_call cache (~/.tim/.session-cache).
 *
 * One global slot shared by every TIM consumer on the host — interactive
 * sessions, workers, cronjobs — and the last writer wins. `expectedCwd` is how
 * a caller checks the slot is its own: the entry is only returned when it names
 * the same directory. Without it the caller cannot tell whose session id it is
 * getting, so it gets none.
 */
export declare function readTimSessionCache(maxAgeMs?: number, expectedCwd?: string): TimSessionCache | null;
/** Active harness session id for MCP / statusline. */
export declare function resolveActiveSessionId(options: {
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
}): string | undefined;
//# sourceMappingURL=session-cache.d.ts.map