import type Database from 'better-sqlite3';
export interface ErrorLogEntry {
    id: number;
    timestamp: string;
    tool: string;
    args_json: string;
    error: string;
    stack: string | null;
    session_id: string | null;
}
export interface ErrorStats {
    totalErrors: number;
    periodHours: number;
    topErrors: {
        error: string;
        count: number;
        lastSeen: string;
    }[];
    errorRate: number;
    alerts: string[];
    byTool: {
        tool: string;
        count: number;
    }[];
}
export interface ErrorLoggerOptions {
    maxEntries?: number;
    maxAgeDays?: number;
}
export declare class ErrorLogger {
    private db;
    private maxEntries;
    private maxAgeDays;
    constructor(db: Database.Database, options?: ErrorLoggerOptions);
    logError(params: {
        tool: string;
        args?: unknown;
        error: string;
        stack?: string;
        sessionId?: string;
    }): void;
    getStats(params?: {
        hours?: number;
        limit?: number;
    }): ErrorStats;
    getAlertThresholds(withinHours?: number): string[];
    rotate(options?: {
        maxEntries?: number;
        maxAgeDays?: number;
    }): {
        deleted: number;
    };
    /**
     * Migrate summarizer.log file content into error_log table.
     * Parses lines like: "2026-06-01T12:00:00.000Z FAIL codex/gpt-5: timeout=600s exit=null"
     */
    migrateSummarizerLog(logContent: string): number;
    /**
     * Bulk-import entries (for CLI tools or external log sources).
     */
    importEntries(entries: Array<{
        timestamp: string;
        tool: string;
        error: string;
        stack?: string;
        sessionId?: string;
    }>): number;
}
//# sourceMappingURL=error-log.d.ts.map