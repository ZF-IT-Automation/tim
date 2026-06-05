"use strict";
// TIM Error Logger — v0.1.0-alpha
// Structured error logging with stats, rotation, and alert thresholds.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorLogger = void 0;
class ErrorLogger {
    db;
    maxEntries;
    maxAgeDays;
    constructor(db, options = {}) {
        this.db = db;
        this.maxEntries = options.maxEntries ?? 10_000;
        this.maxAgeDays = options.maxAgeDays ?? 30;
    }
    logError(params) {
        const { tool, args, error, stack, sessionId } = params;
        const timestamp = new Date().toISOString();
        const argsJson = args ? safeStringify(args) : '{}';
        try {
            this.db.prepare(`
        INSERT INTO error_log (timestamp, tool, args_json, error, stack, session_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(timestamp, tool, argsJson, error, stack ?? null, sessionId ?? null);
        }
        catch {
            // Never let error logging itself cause a crash
        }
    }
    getStats(params = {}) {
        const hours = params.hours ?? 24;
        const limit = params.limit ?? 10;
        const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const countRow = this.db.prepare(`
      SELECT COUNT(*) as total FROM error_log WHERE timestamp >= ?
    `).get(since);
        const totalErrors = countRow.total;
        const topErrors = this.db.prepare(`
      SELECT error, COUNT(*) as count, MAX(timestamp) as lastSeen
      FROM error_log
      WHERE timestamp >= ?
      GROUP BY error
      ORDER BY count DESC
      LIMIT ?
    `).all(since, limit);
        const byTool = this.db.prepare(`
      SELECT tool, COUNT(*) as count
      FROM error_log
      WHERE timestamp >= ?
      GROUP BY tool
      ORDER BY count DESC
    `).all(since);
        const alerts = this.getAlertThresholds(hours);
        return {
            totalErrors,
            periodHours: hours,
            topErrors: topErrors.map(e => ({
                error: truncate(e.error, 200),
                count: e.count,
                lastSeen: e.lastSeen,
            })),
            errorRate: hours > 0 ? Math.round((totalErrors / hours) * 100) / 100 : totalErrors,
            alerts,
            byTool,
        };
    }
    getAlertThresholds(withinHours = 1) {
        const since = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();
        const threshold = 5;
        const rows = this.db.prepare(`
      SELECT error, COUNT(*) as count
      FROM error_log
      WHERE timestamp >= ?
      GROUP BY error
      HAVING count > ?
      ORDER BY count DESC
    `).all(since, threshold);
        return rows.map(r => `ALERT: "${truncate(r.error, 120)}" occurred ${r.count}x in last ${withinHours}h`);
    }
    rotate(options = {}) {
        const maxEntries = options.maxEntries ?? this.maxEntries;
        const maxAgeDays = options.maxAgeDays ?? this.maxAgeDays;
        let deleted = 0;
        // Delete by age
        const ageCutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000).toISOString();
        const ageResult = this.db.prepare(`
      DELETE FROM error_log WHERE timestamp < ?
    `).run(ageCutoff);
        deleted += ageResult.changes;
        // Delete by count (keep newest maxEntries)
        const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM error_log`).get();
        if (countRow.total > maxEntries) {
            const excess = countRow.total - maxEntries;
            const result = this.db.prepare(`
        DELETE FROM error_log WHERE id IN (
          SELECT id FROM error_log ORDER BY timestamp ASC LIMIT ?
        )
      `).run(excess);
            deleted += result.changes;
        }
        return { deleted };
    }
    /**
     * Migrate summarizer.log file content into error_log table.
     * Parses lines like: "2026-06-01T12:00:00.000Z FAIL codex/gpt-5: timeout=600s exit=null"
     */
    migrateSummarizerLog(logContent) {
        let imported = 0;
        const lines = logContent.split('\n').filter(l => l.trim());
        const insert = this.db.prepare(`
      INSERT INTO error_log (timestamp, tool, args_json, error, stack, session_id)
      VALUES (?, ?, '{}', ?, NULL, NULL)
    `);
        const txn = this.db.transaction(() => {
            for (const line of lines) {
                // Format: "2026-06-01T12:00:00.000Z FAIL codex/gpt-5: error detail..."
                const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(FAIL|HEURISTIC)\s+(.+)$/);
                if (!match)
                    continue;
                const [, timestamp, level, detail] = match;
                const colonIdx = detail.indexOf(':');
                let tool = 'summarizer';
                let error = detail;
                if (level === 'FAIL' && colonIdx > 0) {
                    tool = `summarizer/${detail.slice(0, colonIdx)}`;
                    error = detail.slice(colonIdx + 1).trim();
                }
                else if (level === 'HEURISTIC') {
                    error = detail;
                }
                insert.run(timestamp, tool, `[${level}] ${error}`);
                imported++;
            }
        });
        try {
            txn();
        }
        catch {
            // ignore
        }
        return imported;
    }
    /**
     * Bulk-import entries (for CLI tools or external log sources).
     */
    importEntries(entries) {
        let count = 0;
        const insert = this.db.prepare(`
      INSERT INTO error_log (timestamp, tool, args_json, error, stack, session_id)
      VALUES (?, ?, '{}', ?, ?, ?)
    `);
        const txn = this.db.transaction(() => {
            for (const e of entries) {
                insert.run(e.timestamp, e.tool, e.error, e.stack ?? null, e.sessionId ?? null);
                count++;
            }
        });
        try {
            txn();
        }
        catch {
            // ignore
        }
        return count;
    }
}
exports.ErrorLogger = ErrorLogger;
function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    }
    catch {
        return '{}';
    }
}
function truncate(s, maxLen) {
    if (s.length <= maxLen)
        return s;
    return s.slice(0, maxLen - 3) + '...';
}
//# sourceMappingURL=error-log.js.map