export interface ParseOptions {
    valueOptions?: ReadonlySet<string>;
}
export interface ParsedArgs {
    flags: Record<string, string>;
    positional: string[];
}
export declare function parseArgs(args: string[], options?: ParseOptions): ParsedArgs;
//# sourceMappingURL=args.d.ts.map