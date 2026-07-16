"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEW_PROJECT_ALIASES = exports.MissingOptionValueError = void 0;
exports.valueOptionsFor = valueOptionsFor;
exports.parseArgs = parseArgs;
class MissingOptionValueError extends Error {
    option;
    constructor(option) {
        super(`Missing value for --${option}`);
        this.name = 'MissingOptionValueError';
        this.option = option;
    }
}
exports.MissingOptionValueError = MissingOptionValueError;
const EMPTY_VALUE_OPTIONS = new Set();
const COMMAND_VALUE_OPTIONS = {
    'resolve-project': new Set(['cwd', 'format']),
    'resolve-session': new Set(['session', 'cwd', 'format']),
    'bind-project': new Set(['label', 'cwd', 'session']),
    'new-project': new Set(['path', 'name']),
    'record-commit': new Set([
        'cwd', 'project', 'session', 'hash', 'message', 'diff', 'author', 'date', 'branch',
    ]),
    hook: new Set([
        'session', 'agent', 'cwd', 'harness', 'project', 'tool', 'model', 'task-summary', 'user',
    ]),
    checkpoint: new Set(['session', 'handoff-note']),
    rebalance: new Set(['session', 'cwd']),
    statusline: new Set(['cwd', 'session', 'format']),
    export: new Set(['format']),
    'migrate tags-to-types': new Set(['sample-limit']),
    snapshot: new Set(['db', 'out', 'prune-hours']),
    restore: new Set(['from', 'db']),
    'release-check': new Set(['skip-tests']),
    'setup-agent': new Set(['host']),
    'sync connect': new Set(['server-url', 'user-id', 'token', 'tier', 'passphrase']),
    'sync push': new Set(['passphrase']),
    'sync pull': new Set(['passphrase']),
    'sync dev': new Set(['port']),
    'root-entries': new Set(['type', 'tag', 'format']),
    consolidate: new Set(['project', 'threshold', 'access-days', 'access-count', 'verified-days']),
};
exports.NEW_PROJECT_ALIASES = {
    p: 'path',
    n: 'name',
    h: 'help',
};
function valueOptionsFor(command, subcommand) {
    if (subcommand) {
        const nested = COMMAND_VALUE_OPTIONS[`${command} ${subcommand}`];
        if (nested)
            return nested;
    }
    return COMMAND_VALUE_OPTIONS[command] ?? EMPTY_VALUE_OPTIONS;
}
function parseArgs(args, options = {}) {
    const flags = {};
    const positional = [];
    let terminated = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!terminated && arg === '--') {
            terminated = true;
            continue;
        }
        const isLongOption = !terminated && arg.startsWith('--');
        const isShortOption = !terminated &&
            arg.startsWith('-') &&
            !arg.startsWith('--') &&
            arg !== '-' &&
            options.aliases?.[arg.slice(1).split('=', 1)[0]] !== undefined;
        if (isLongOption || isShortOption) {
            const equalsIndex = arg.indexOf('=');
            const rawKey = arg.slice(isLongOption ? 2 : 1, equalsIndex === -1 ? undefined : equalsIndex);
            const key = isShortOption ? options.aliases[rawKey] : rawKey;
            if (equalsIndex !== -1) {
                flags[key] = arg.slice(equalsIndex + 1);
                continue;
            }
            const expectsValue = options.valueOptions?.has(key) === true;
            const next = args[i + 1];
            if (expectsValue && next === undefined) {
                throw new MissingOptionValueError(key);
            }
            if (expectsValue) {
                flags[key] = next;
                i++;
            }
            else {
                flags[key] = 'true';
            }
        }
        else {
            positional.push(arg);
        }
    }
    return { flags, positional };
}
//# sourceMappingURL=args.js.map