export declare function isBrokenPipeError(err: unknown): boolean;
export declare function handleUncaughtException(err: Error, log: (err: Error) => void, exit: (code: number) => void): void;
/** stdout/stderr 'error' — same rule as uncaughtException: broken pipe exits, no DB write. */
export declare function handleStdioStreamError(err: unknown, exit: (code: number) => void): void;
//# sourceMappingURL=process-error-guards.d.ts.map