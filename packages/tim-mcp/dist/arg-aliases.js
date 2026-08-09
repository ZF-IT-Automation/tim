"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyArgAliases = applyArgAliases;
exports.explainMissingParams = explainMissingParams;
const zod_1 = require("zod");
/**
 * Parameter names callers actually guessed, mapped to the name the schema wants.
 *
 * Every entry here comes from a row in the error log — a real call that was lost
 * because a neighbouring tool spells the same argument differently. This is not a
 * place for imagined synonyms: add an alias when a caller has already paid for it.
 *
 * Keyed per tool on purpose. A global rename table would break parameters that are
 * deliberately named differently across tools (`tim_read.include_body` is snake_case
 * because it always has been).
 */
const TOOL_ALIASES = {
    tim_load_project: { project: 'label', projectId: 'label' },
    tim_read: { parentLabel: 'project', sectionTitle: 'section' },
};
/**
 * Rewrite known alias keys to their canonical names. The canonical key always wins:
 * if a caller passes both, the alias is left alone rather than overwriting real input.
 * Returns the original object untouched when there is nothing to rename.
 */
function applyArgAliases(tool, args) {
    const aliases = TOOL_ALIASES[tool];
    if (!aliases || args === null || typeof args !== 'object' || Array.isArray(args))
        return args;
    const src = args;
    let out = null;
    for (const [from, to] of Object.entries(aliases)) {
        if (from in src && !(to in src)) {
            out ??= { ...src };
            out[to] = out[from];
            delete out[from];
        }
    }
    return out ?? args;
}
/**
 * Turn a Zod "Required" failure into a message that names the parameter the tool
 * wants and the ones the caller actually sent, instead of dumping the raw issue
 * array. Returns null for anything else, so the caller falls back to error.message.
 */
function explainMissingParams(tool, error, args, validKeys) {
    if (!(error instanceof zod_1.ZodError))
        return null;
    const missing = error.issues
        .filter(i => i.code === 'invalid_type' && i.received === 'undefined' && i.path.length > 0)
        .map(i => String(i.path[0]));
    if (missing.length === 0)
        return null;
    const unique = [...new Set(missing)];
    const passed = args && typeof args === 'object' && !Array.isArray(args)
        ? Object.keys(args)
        : [];
    // A caller who sent a directory instead of a name wanted marker resolution.
    // Naming the file is cheaper than teaching every tool to walk the tree.
    const sentCwd = tool === 'tim_load_project' && unique.includes('label') && passed.includes('cwd');
    return [
        `${tool}: missing required parameter${unique.length > 1 ? 's' : ''} ${unique.map(k => `'${k}'`).join(', ')}.`,
        passed.length > 0 ? ` Received: ${passed.join(', ')}.` : ' Received no arguments.',
        ` Valid parameters: ${validKeys.join(', ')}.`,
        sentCwd
            ? " 'label' takes a label (P0063), an alias, or the project name (TIM) — a directory is not one." +
                ' To go from a directory to a project, read the nearest .tim-project file walking up from it' +
                ' and pass the label it names.'
            : '',
    ].join('');
}
//# sourceMappingURL=arg-aliases.js.map