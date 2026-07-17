export interface ParseOptions {
    valueOptions?: ReadonlySet<string>;
    aliases?: Readonly<Record<string, string>>;
}
export interface ParsedArgs {
    flags: Record<string, string>;
    positional: string[];
}
export declare class MissingOptionValueError extends Error {
    readonly option: string;
    constructor(option: string);
}
export declare const NEW_PROJECT_ALIASES: Readonly<Record<string, string>>;
export declare function valueOptionsFor(command: string, subcommand?: string): ReadonlySet<string>;
export declare function hasBooleanFlag(args: string[], target: string, options?: ParseOptions): boolean;
export declare function parseArgs(args: string[], options?: ParseOptions): ParsedArgs;
//# sourceMappingURL=args.d.ts.map