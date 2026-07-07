"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.timSessionCachePath = timSessionCachePath;
exports.readTimSessionCache = readTimSessionCache;
exports.resolveActiveSessionId = resolveActiveSessionId;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
function timSessionCachePath() {
    const dir = process.env.TIM_CACHE_DIR?.trim() || path.join(os.homedir(), '.tim');
    return path.join(dir, '.session-cache');
}
/** Hermes pre_llm_call cache (~/.tim/.session-cache). */
function readTimSessionCache(maxAgeMs = 3_600_000) {
    const p = timSessionCachePath();
    if (!fs.existsSync(p))
        return null;
    try {
        const stat = fs.statSync(p);
        if (maxAgeMs > 0 && Date.now() - stat.mtimeMs > maxAgeMs)
            return null;
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const session_id = typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
        if (!session_id)
            return null;
        const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
        const ts = typeof raw.ts === 'string' ? raw.ts : undefined;
        return { session_id, cwd, ts };
    }
    catch {
        return null;
    }
}
/** Active harness session id for MCP / statusline. */
function resolveActiveSessionId(options) {
    const fromArg = options.sessionIdArg?.trim();
    if (fromArg)
        return fromArg;
    if (options.useEnv !== false) {
        const fromEnv = options.envSessionId?.trim() || process.env.TIM_SESSION_ID?.trim();
        if (fromEnv)
            return fromEnv;
    }
    if (options.useSessionCache !== false) {
        const cached = readTimSessionCache(options.cacheMaxAgeMs);
        if (cached?.session_id)
            return cached.session_id;
    }
    const fromMarker = options.markerSession?.trim();
    if (fromMarker)
        return fromMarker;
    return undefined;
}
//# sourceMappingURL=session-cache.js.map