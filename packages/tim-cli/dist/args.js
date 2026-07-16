"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
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
        if (!terminated && arg.startsWith('--')) {
            const equalsIndex = arg.indexOf('=');
            const key = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
            if (equalsIndex !== -1) {
                flags[key] = arg.slice(equalsIndex + 1);
                continue;
            }
            const next = args[i + 1];
            const takesValue = next !== undefined &&
                (options.valueOptions?.has(key) === true || !next.startsWith('--'));
            if (takesValue) {
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