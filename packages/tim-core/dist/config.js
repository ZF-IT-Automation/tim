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
exports.getTimDir = getTimDir;
exports.getConfigPath = getConfigPath;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.normalizeHookScripts = normalizeHookScripts;
exports.hooksEnabled = hooksEnabled;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const DEFAULT_REMEMBER_CHAIN = [
    { cli: 'opencode', model: 'claude-3-5-haiku', provider: 'anthropic' },
    { cli: 'opencode', model: 'deepseek-v4-pro', provider: 'deepseek' },
    { cli: 'opencode', model: 'kimi', provider: 'moonshot' },
];
const DEFAULT_CONFIG = {
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
};
function getTimDir() {
    return path.join(os.homedir(), '.tim');
}
function getConfigPath() {
    return path.join(getTimDir(), 'config.json');
}
function loadConfig() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        return { ...DEFAULT_CONFIG };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return {
            ...DEFAULT_CONFIG,
            ...raw,
            hooks: {
                ...DEFAULT_CONFIG.hooks,
                ...raw.hooks,
            },
            remember: {
                ...DEFAULT_CONFIG.remember,
                ...raw.remember,
                chain: raw.remember?.chain ?? DEFAULT_CONFIG.remember?.chain,
            },
        };
    }
    catch {
        return { ...DEFAULT_CONFIG };
    }
}
function saveConfig(config) {
    const timDir = getTimDir();
    if (!fs.existsSync(timDir)) {
        fs.mkdirSync(timDir, { recursive: true });
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}
function normalizeHookScripts(scripts) {
    if (!scripts)
        return [];
    return Array.isArray(scripts) ? scripts : [scripts];
}
function hooksEnabled(config) {
    return config.hooks?.enabled !== false;
}
//# sourceMappingURL=config.js.map