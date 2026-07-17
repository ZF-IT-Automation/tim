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
exports.mergeClaudeHooks = mergeClaudeHooks;
exports.installClaudeHooks = installClaudeHooks;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const TIM_PROMPT = {
    matcher: '',
    hooks: [{ type: 'command', command: 'tim hook prompt-submit', timeout: 2 }],
};
const TIM_STOP = {
    matcher: '',
    hooks: [{ type: 'command', command: 'tim hook claude-stop', timeout: 5 }],
};
function appendUnique(existing, value) {
    const items = existing ?? [];
    const command = value.hooks[0]?.command;
    return items.some(item => item.hooks.some(hook => hook.command === command))
        ? items
        : [...items, value];
}
function mergeClaudeHooks(settings) {
    return {
        ...settings,
        hooks: {
            ...settings.hooks,
            UserPromptSubmit: appendUnique(settings.hooks?.UserPromptSubmit, TIM_PROMPT),
            Stop: appendUnique(settings.hooks?.Stop, TIM_STOP),
        },
    };
}
function defaultSettingsPath() {
    return path.join(os.homedir(), '.claude', 'settings.json');
}
function writeAtomicJson(filePath, value) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.settings.json.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}
function installClaudeHooks(options = {}) {
    const settingsPath = options.settingsPath ?? defaultSettingsPath();
    let existing = {};
    if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {
                    status: 'skipped',
                    settingsPath,
                    reason: 'settings.json is not a JSON object',
                };
            }
            existing = parsed;
        }
        catch {
            return {
                status: 'skipped',
                settingsPath,
                reason: 'settings.json is invalid JSON',
            };
        }
    }
    const next = mergeClaudeHooks(existing);
    if (JSON.stringify(next) === JSON.stringify(existing)) {
        return { status: 'unchanged', settingsPath };
    }
    let backupPath;
    if (fs.existsSync(settingsPath)) {
        backupPath = `${settingsPath}.backup.${Date.now()}`;
        fs.copyFileSync(settingsPath, backupPath);
    }
    writeAtomicJson(settingsPath, next);
    return { status: 'installed', settingsPath, backupPath };
}
//# sourceMappingURL=claude-hooks-install.js.map