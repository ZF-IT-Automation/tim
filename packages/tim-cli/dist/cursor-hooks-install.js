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
exports.TURN_END_EVENTS = void 0;
exports.cursorHome = cursorHome;
exports.detectCursor = detectCursor;
exports.cursorStopCommand = cursorStopCommand;
exports.mergeCursorSessionStart = mergeCursorSessionStart;
exports.mergeCursorTurnEnd = mergeCursorTurnEnd;
exports.installCursorSessionStartHook = installCursorSessionStartHook;
exports.installCursorTurnEndHooks = installCursorTurnEndHooks;
exports.installCursorHooks = installCursorHooks;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
/** Cursor fires the turn-end hook per turn in the TUI, once per run under -p. */
exports.TURN_END_EVENTS = ['stop', 'sessionEnd'];
function cursorHome() {
    return path.join(os.homedir(), '.cursor');
}
/** Cursor is present if it left a home behind or is on PATH. */
function detectCursor(home = cursorHome()) {
    if (fs.existsSync(home))
        return true;
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    return dirs.some(dir => fs.existsSync(path.join(dir, 'cursor-agent')));
}
function timCliPath() {
    return path.resolve(__dirname, 'cli.js');
}
function sessionStartScript() {
    return path.resolve(__dirname, '..', '..', 'tim-hooks', 'scripts', 'tim-session-start.sh');
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
 * Absolute node, like the Codex installer writes: hooks spawn without a login
 * shell, so a version-managed node is not on the PATH they inherit.
 */
function cursorStopCommand(cli = timCliPath(), node = process.execPath) {
    return `${shellQuote(node)} ${shellQuote(cli)} hook cursor-stop`;
}
function writeAtomic(filePath, contents) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, filePath);
}
function hasCommand(entries, needle) {
    return entries.some(entry => typeof entry.command === 'string' && entry.command.includes(needle));
}
function withHook(file, event, command, needle, timeout) {
    const entries = file.hooks?.[event] ?? [];
    if (hasCommand(entries, needle))
        return file;
    return {
        ...file,
        version: file.version ?? 1,
        hooks: { ...file.hooks, [event]: [...entries, { command, timeout }] },
    };
}
/** Matches on the script name, so a hand-placed session-start hook is reused. */
function mergeCursorSessionStart(file, command) {
    return withHook(file, 'sessionStart', command, 'tim-session-start', 10);
}
function mergeCursorTurnEnd(file, command) {
    let next = file;
    for (const event of exports.TURN_END_EVENTS) {
        next = withHook(next, event, command, 'hook cursor-stop', 10);
    }
    return next;
}
function readHooksFile(hooksPath) {
    if (!fs.existsSync(hooksPath))
        return {};
    try {
        const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return 'hooks.json is not a JSON object';
        }
        return parsed;
    }
    catch {
        return 'hooks.json is invalid JSON';
    }
}
function applyMerge(step, hooksPath, merge) {
    const existing = readHooksFile(hooksPath);
    if (typeof existing === 'string') {
        return { step, status: 'skip', path: hooksPath, detail: existing };
    }
    const next = merge(existing);
    if (JSON.stringify(next) === JSON.stringify(existing)) {
        return { step, status: 'unchanged', path: hooksPath };
    }
    if (fs.existsSync(hooksPath))
        fs.copyFileSync(hooksPath, `${hooksPath}.backup.${Date.now()}`);
    writeAtomic(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
    return { step, status: 'installed', path: hooksPath };
}
function installCursorSessionStartHook(options = {}) {
    const hooksPath = options.hooksPath ?? path.join(cursorHome(), 'hooks.json');
    const script = options.script ?? sessionStartScript();
    if (!fs.existsSync(script)) {
        return {
            step: 'session-start-hook',
            status: 'skip',
            path: hooksPath,
            detail: `shipped hook script not found at ${script}`,
        };
    }
    return applyMerge('session-start-hook', hooksPath, file => mergeCursorSessionStart(file, `bash ${script}`));
}
function installCursorTurnEndHooks(options = {}) {
    const hooksPath = options.hooksPath ?? path.join(cursorHome(), 'hooks.json');
    const command = cursorStopCommand(options.cli ?? timCliPath());
    return applyMerge('turn-end-hooks', hooksPath, file => mergeCursorTurnEnd(file, command));
}
function installCursorHooks(options = {}) {
    // Sequential: both steps write the same file, so the second must read the first.
    const steps = [
        installCursorTurnEndHooks({ hooksPath: options.hooksPath, cli: options.cli }),
        installCursorSessionStartHook({ hooksPath: options.hooksPath, script: options.script }),
    ];
    return {
        ok: steps.every(step => step.status !== 'skip'),
        steps,
        notes: [
            'Restart any running cursor-agent session to pick the hooks up.',
            'Exchanges are logged per turn in the interactive TUI and once per run under ' +
                '`cursor-agent -p`, which fires no turn-end hook of its own.',
        ],
    };
}
//# sourceMappingURL=cursor-hooks-install.js.map