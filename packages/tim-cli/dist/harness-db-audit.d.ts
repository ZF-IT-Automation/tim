export interface HarnessDbFinding {
    /** The harness config file the value was read from. */
    configPath: string;
    /** The TIM_DB_PATH value as written in the file. */
    configured: string;
    /** Whether it resolves to the database `tim doctor` itself is looking at. */
    matches: boolean;
}
/** Global MCP config of every known host, plus Codex, which is not an MCP host entry. */
export declare function harnessConfigFiles(): string[];
/**
 * Read-only check for `tim doctor`: does every harness talk to the database this
 * doctor run is reporting on? A harness pointed elsewhere fails silently — memory
 * reads come back empty, which is indistinguishable from "nothing recorded yet",
 * so no agent will ever raise it. Found on 2026-08-12 after a smoke test left three
 * live configs pointing at a scratchpad database for three days.
 */
export declare function auditHarnessDbPaths(expectedDbPath: string, files?: string[]): HarnessDbFinding[];
//# sourceMappingURL=harness-db-audit.d.ts.map