"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCK_TTL_MS = exports.DEFAULT_SUMMARIZER_TIMEOUT_SEC = void 0;
/** Shared summarizer timing — single source for lock TTL vs CLI timeout. */
exports.DEFAULT_SUMMARIZER_TIMEOUT_SEC = 600;
/** Lock must outlive the longest legal summarizer run (+ SIGTERM tail). */
exports.LOCK_TTL_MS = (exports.DEFAULT_SUMMARIZER_TIMEOUT_SEC + 120) * 1000;
//# sourceMappingURL=constants.js.map