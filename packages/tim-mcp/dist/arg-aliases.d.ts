/**
 * Rewrite known alias keys to their canonical names. The canonical key always wins:
 * if a caller passes both, the alias is left alone rather than overwriting real input.
 * Returns the original object untouched when there is nothing to rename.
 */
export declare function applyArgAliases(tool: string, args: unknown): unknown;
/**
 * Turn a Zod "Required" failure into a message that names the parameter the tool
 * wants and the ones the caller actually sent, instead of dumping the raw issue
 * array. Returns null for anything else, so the caller falls back to error.message.
 */
export declare function explainMissingParams(tool: string, error: unknown, args: unknown, validKeys: string[]): string | null;
//# sourceMappingURL=arg-aliases.d.ts.map