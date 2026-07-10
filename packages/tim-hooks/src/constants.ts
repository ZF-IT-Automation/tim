/** Shared summarizer timing — single source for lock TTL vs CLI timeout. */
export const DEFAULT_SUMMARIZER_TIMEOUT_SEC = 600;

/** Lock must outlive the longest legal summarizer run (+ SIGTERM tail). */
export const LOCK_TTL_MS = (DEFAULT_SUMMARIZER_TIMEOUT_SEC + 120) * 1000;
