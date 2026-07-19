"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARKER_LOCK = exports.SUMMARIZER_LOCK = exports.TIM_META_DIR = exports.LOCK_TTL_MS = exports.DEFAULT_SUMMARIZER_TIMEOUT_SEC = void 0;
/** Shared summarizer timing — single source for lock TTL vs CLI timeout. */
exports.DEFAULT_SUMMARIZER_TIMEOUT_SEC = 600;
/** Lock must outlive the longest legal summarizer run (+ SIGTERM tail). */
exports.LOCK_TTL_MS = (exports.DEFAULT_SUMMARIZER_TIMEOUT_SEC + 120) * 1000;
/** Per-cwd metadata directory beside the project marker. */
exports.TIM_META_DIR = '.tim';
/** Summarizer process lock filename (lives under {@link TIM_META_DIR}). */
exports.SUMMARIZER_LOCK = 'summarizer.lock';
/**
 * @deprecated Pre–marker-slimming lock basename at cwd root. Ignored after v3;
 * use {@link SUMMARIZER_LOCK} under {@link TIM_META_DIR}.
 */
exports.MARKER_LOCK = '.tim-project.lock';
//# sourceMappingURL=constants.js.map