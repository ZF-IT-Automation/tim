/** Shared summarizer timing — single source for lock TTL vs CLI timeout. */
export const DEFAULT_SUMMARIZER_TIMEOUT_SEC = 600;

/** Lock must outlive the longest legal summarizer run (+ SIGTERM tail). */
export const LOCK_TTL_MS = (DEFAULT_SUMMARIZER_TIMEOUT_SEC + 120) * 1000;

/** Per-cwd metadata directory beside the project marker. */
export const TIM_META_DIR = '.tim';

/** Summarizer process lock filename (lives under {@link TIM_META_DIR}). */
export const SUMMARIZER_LOCK = 'summarizer.lock';

/**
 * @deprecated Pre–marker-slimming lock basename at cwd root. Ignored after v3;
 * use {@link SUMMARIZER_LOCK} under {@link TIM_META_DIR}.
 */
export const MARKER_LOCK = '.tim-project.lock';
