"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEW_PROJECT_ALIASES = exports.MissingOptionValueError = void 0;
exports.valueOptionsFor = valueOptionsFor;
exports.hasBooleanFlag = hasBooleanFlag;
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
    'bind-project': new Set(['label', 'cwd']),
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
function parseOptionToken(arg, aliases) {
    const isLongOption = arg.startsWith('--') && arg !== '--';
    const rawShortKey = arg.startsWith('-') && !arg.startsWith('--') && arg !== '-'
        ? arg.slice(1).split('=', 1)[0]
        : undefined;
    const isShortOption = rawShortKey !== undefined && aliases?.[rawShortKey] !== undefined;
    if (!isLongOption && !isShortOption)
        return undefined;
    const equalsIndex = arg.indexOf('=');
    const rawKey = arg.slice(isLongOption ? 2 : 1, equalsIndex === -1 ? undefined : equalsIndex);
    return {
        key: isShortOption ? aliases[rawKey] : rawKey,
        hasInlineValue: equalsIndex !== -1,
        inlineValue: equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1),
    };
}
function hasBooleanFlag(args, target, options = {}) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--')
            return false;
        const option = parseOptionToken(arg, options.aliases);
        if (!option)
            continue;
        if (option.hasInlineValue)
            continue;
        if (options.valueOptions?.has(option.key) === true) {
            if (args[i + 1] === undefined)
                throw new MissingOptionValueError(option.key);
            i++;
            continue;
        }
        if (option.key === target)
            return true;
    }
    return false;
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
        const option = !terminated ? parseOptionToken(arg, options.aliases) : undefined;
        if (option) {
            const key = option.key;
            if (option.hasInlineValue) {
                flags[key] = option.inlineValue;
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