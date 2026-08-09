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
exports.codexHome = codexHome;
exports.detectCodex = detectCodex;
exports.codexNotifyLine = codexNotifyLine;
exports.mergeCodexNotify = mergeCodexNotify;
exports.installCodexNotify = installCodexNotify;
exports.mergeCodexSessionStart = mergeCodexSessionStart;
exports.installCodexSessionStartHook = installCodexSessionStartHook;
exports.installCodexHooks = installCodexHooks;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const NOTIFY_LINE_RE = /^[ \t]*notify[ \t]*=/m;
const TIM_NOTIFY_MARKER = 'hook", "codex-notify"';
function codexHome() {
    return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
/** Codex is present if it left a home behind or is on PATH. */
function detectCodex(home = codexHome()) {
    if (fs.existsSync(home))
        return true;
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    return dirs.some(dir => fs.existsSync(path.join(dir, 'codex')));
}
function timCliPath() {
    return path.resolve(__dirname, 'cli.js');
}
/**
 * Absolute node, like the MCP installer writes: `notify` spawns without a login
 * shell, so a version-managed node is not on the PATH it inherits.
 */
function codexNotifyLine(cli = timCliPath(), node = process.execPath) {
    return `notify = [${JSON.stringify(node)}, ${JSON.stringify(cli)}, "hook", "codex-notify"]`;
}
function writeAtomic(filePath, contents) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, filePath);
}
/**
 * `notify` is a single top-level key, so it must go above the first `[table]`
 * header — appending at EOF would bury it inside whatever section ends the file.
 */
function mergeCodexNotify(existing, line) {
    return existing.trim() ? `${line}\n${existing}` : `${line}\n`;
}
function installCodexNotify(options = {}) {
    const configPath = options.configPath ?? path.join(codexHome(), 'config.toml');
    const line = codexNotifyLine(options.cli ?? timCliPath());
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const current = NOTIFY_LINE_RE.exec(existing);
    if (current) {
        const claimed = existing.slice(current.index).split('\n')[0] ?? '';
        return claimed.includes(TIM_NOTIFY_MARKER)
            ? { step: 'notify', status: 'unchanged', path: configPath }
            : {
                step: 'notify',
                status: 'skip',
                path: configPath,
                detail: `notify already claimed by another owner — left alone: ${claimed.trim()}`,
            };
    }
    if (existing)
        fs.copyFileSync(configPath, `${configPath}.backup.${Date.now()}`);
    writeAtomic(configPath, mergeCodexNotify(existing, line));
    return { step: 'notify', status: 'installed', path: configPath };
}
function sessionStartScript() {
    return path.resolve(__dirname, '..', '..', 'tim-hooks', 'scripts', 'tim-session-start.sh');
}
/**
 * The entry may already be there under a hand-placed path, so match on the
 * script name rather than the exact command string — an exact match would
 * install a second session-start hook next to the existing one.
 */
function mergeCodexSessionStart(file, command) {
    const groups = file.hooks?.SessionStart ?? [];
    const alreadyThere = groups.some(group => group.hooks.some(hook => hook.command.includes('tim-session-start') || hook.command.includes('hook claude-session-start')));
    if (alreadyThere)
        return file;
    return {
        ...file,
        hooks: {
            ...file.hooks,
            SessionStart: [
                ...groups,
                { matcher: 'startup|resume', hooks: [{ type: 'command', command, timeout: 10 }] },
            ],
        },
    };
}
function installCodexSessionStartHook(options = {}) {
    const hooksPath = options.hooksPath ?? path.join(codexHome(), 'hooks.json');
    const script = options.script ?? sessionStartScript();
    if (!fs.existsSync(script)) {
        return { step: 'session-start-hook', status: 'skip', path: hooksPath, detail: `shipped hook script not found at ${script}` };
    }
    let existing = {};
    if (fs.existsSync(hooksPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { step: 'session-start-hook', status: 'skip', path: hooksPath, detail: 'hooks.json is not a JSON object' };
            }
            existing = parsed;
        }
        catch {
            return { step: 'session-start-hook', status: 'skip', path: hooksPath, detail: 'hooks.json is invalid JSON' };
        }
    }
    const next = mergeCodexSessionStart(existing, `bash ${script}`);
    if (JSON.stringify(next) === JSON.stringify(existing)) {
        return { step: 'session-start-hook', status: 'unchanged', path: hooksPath };
    }
    if (fs.existsSync(hooksPath))
        fs.copyFileSync(hooksPath, `${hooksPath}.backup.${Date.now()}`);
    writeAtomic(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
    return { step: 'session-start-hook', status: 'installed', path: hooksPath };
}
function installCodexHooks(options = {}) {
    const steps = [
        installCodexNotify({ configPath: options.configPath, cli: options.cli }),
        installCodexSessionStartHook({ hooksPath: options.hooksPath, script: options.script }),
    ];
    return {
        ok: steps.every(step => step.status !== 'skip'),
        steps,
        notes: [
            'notify logs exchanges and works immediately — restart any running Codex session to pick it up.',
            'Codex skips hooks.json entries until they are trusted: run `codex` once and approve the hook, ' +
                'or start it with --dangerously-bypass-hook-trust. Until then the session-start briefing stays silent.',
        ],
    };
}
//# sourceMappingURL=codex-hooks-install.js.map