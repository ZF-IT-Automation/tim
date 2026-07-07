export interface TimSessionCache {
    session_id: string;
    cwd: string;
    ts?: string;
}
export declare function timSessionCachePath(): string;
/** Hermes pre_llm_call cache (~/.tim/.session-cache). */
export declare function readTimSessionCache(maxAgeMs?: number): TimSessionCache | null;
/** Active harness session id for MCP / statusline. */
export declare function resolveActiveSessionId(options: {
    sessionIdArg?: string;
    envSessionId?: string;
    markerSession?: string;
    cacheMaxAgeMs?: number;
    /** Set false in daemon/HTTP contexts — the cache file is per-machine, not per-client. */
    useSessionCache?: boolean;
    /** Set false in daemon/HTTP contexts — env is daemon-global. */
    useEnv?: boolean;
}): string | undefined;
//# sourceMappingURL=session-cache.d.ts.map