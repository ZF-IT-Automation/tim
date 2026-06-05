"use strict";
// ErrorLogger Tests — v0.1.0-alpha
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const error_log_js_1 = require("../error-log.js");
const schema_js_1 = require("../schema.js");
function createTestDb() {
    const db = new better_sqlite3_1.default(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    (0, schema_js_1.runMigrations)(db);
    return db;
}
let db;
let logger;
(0, vitest_1.beforeEach)(() => {
    db = createTestDb();
    logger = new error_log_js_1.ErrorLogger(db, { maxEntries: 100, maxAgeDays: 30 });
});
(0, vitest_1.afterEach)(() => {
    db.close();
});
(0, vitest_1.describe)('ErrorLogger', () => {
    (0, vitest_1.describe)('logError', () => {
        (0, vitest_1.it)('should log an error entry', () => {
            logger.logError({
                tool: 'tim_read',
                error: 'Entry not found',
            });
            const row = db.prepare('SELECT * FROM error_log').get();
            (0, vitest_1.expect)(row).toBeTruthy();
            (0, vitest_1.expect)(row.tool).toBe('tim_read');
            (0, vitest_1.expect)(row.error).toBe('Entry not found');
            (0, vitest_1.expect)(row.timestamp).toBeTruthy();
            (0, vitest_1.expect)(row.args_json).toBe('{}');
            (0, vitest_1.expect)(row.stack).toBeNull();
            (0, vitest_1.expect)(row.session_id).toBeNull();
        });
        (0, vitest_1.it)('should log with all fields', () => {
            logger.logError({
                tool: 'tim_write',
                args: { content: 'test' },
                error: 'DB error',
                stack: 'Error: DB error\n  at foo.ts:10',
                sessionId: 'ses-123',
            });
            const row = db.prepare('SELECT * FROM error_log').get();
            (0, vitest_1.expect)(row.tool).toBe('tim_write');
            (0, vitest_1.expect)(row.args_json).toContain('test');
            (0, vitest_1.expect)(row.error).toBe('DB error');
            (0, vitest_1.expect)(row.stack).toContain('foo.ts:10');
            (0, vitest_1.expect)(row.session_id).toBe('ses-123');
        });
        (0, vitest_1.it)('should handle circular JSON args gracefully', () => {
            const circ = { name: 'circ' };
            circ.self = circ;
            (0, vitest_1.expect)(() => {
                logger.logError({ tool: 'test', args: circ, error: 'circular' });
            }).not.toThrow();
            const row = db.prepare('SELECT * FROM error_log').get();
            (0, vitest_1.expect)(row.args_json).toBe('{}');
        });
        (0, vitest_1.it)('should not throw on DB errors (self-healing)', () => {
            db.close(); // kill DB
            (0, vitest_1.expect)(() => {
                logger.logError({ tool: 'test', error: 'after close' });
            }).not.toThrow();
        });
    });
    (0, vitest_1.describe)('getStats', () => {
        (0, vitest_1.it)('should return empty stats when no errors', () => {
            const stats = logger.getStats({ hours: 24 });
            (0, vitest_1.expect)(stats.totalErrors).toBe(0);
            (0, vitest_1.expect)(stats.errorRate).toBe(0);
            (0, vitest_1.expect)(stats.topErrors).toEqual([]);
            (0, vitest_1.expect)(stats.byTool).toEqual([]);
            (0, vitest_1.expect)(stats.alerts).toEqual([]);
        });
        (0, vitest_1.it)('should return stats with errors', () => {
            logger.logError({ tool: 'tim_read', error: 'not found' });
            logger.logError({ tool: 'tim_read', error: 'not found' });
            logger.logError({ tool: 'tim_write', error: 'DB locked' });
            const stats = logger.getStats({ hours: 24, limit: 10 });
            (0, vitest_1.expect)(stats.totalErrors).toBe(3);
            (0, vitest_1.expect)(stats.topErrors).toHaveLength(2); // 2 unique errors
            (0, vitest_1.expect)(stats.topErrors[0].error).toBe('not found');
            (0, vitest_1.expect)(stats.topErrors[0].count).toBe(2);
            (0, vitest_1.expect)(stats.byTool).toHaveLength(2);
        });
        (0, vitest_1.it)('should respect hours filter', () => {
            // Insert error with old timestamp
            const oldDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
            db.prepare(`
        INSERT INTO error_log (timestamp, tool, args_json, error)
        VALUES (?, 'tim_old', '{}', 'old error')
      `).run(oldDate);
            logger.logError({ tool: 'tim_new', error: 'new error' });
            const stats = logger.getStats({ hours: 24 });
            (0, vitest_1.expect)(stats.totalErrors).toBe(1); // only "new error"
        });
    });
    (0, vitest_1.describe)('getAlertThresholds', () => {
        (0, vitest_1.it)('should flag >5 identical errors in 1h', () => {
            const error = 'Connection refused';
            for (let i = 0; i < 6; i++) {
                logger.logError({ tool: 'tim_sync', error });
            }
            const stats = logger.getStats({ hours: 1 });
            (0, vitest_1.expect)(stats.alerts).toHaveLength(1);
            (0, vitest_1.expect)(stats.alerts[0]).toContain('Connection refused');
            (0, vitest_1.expect)(stats.alerts[0]).toContain('6x');
        });
        (0, vitest_1.it)('should not flag <=5 identical errors', () => {
            const error = 'Timeout';
            for (let i = 0; i < 5; i++) {
                logger.logError({ tool: 'tim_read', error });
            }
            const stats = logger.getStats({ hours: 1 });
            (0, vitest_1.expect)(stats.alerts).toHaveLength(0);
        });
    });
    (0, vitest_1.describe)('rotate', () => {
        (0, vitest_1.it)('should delete old entries by age', () => {
            const oldDate = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
            db.prepare(`
        INSERT INTO error_log (timestamp, tool, args_json, error)
        VALUES (?, 'tim_old', '{}', 'old')
      `).run(oldDate);
            logger.logError({ tool: 'tim_new', error: 'new' });
            const result = logger.rotate({ maxAgeDays: 30 });
            (0, vitest_1.expect)(result.deleted).toBe(1);
            const remaining = db.prepare('SELECT COUNT(*) as c FROM error_log').get();
            (0, vitest_1.expect)(remaining.c).toBe(1);
        });
        (0, vitest_1.it)('should delete oldest entries when exceeding maxEntries', () => {
            for (let i = 0; i < 10; i++) {
                logger.logError({ tool: 'test', error: `err ${i}` });
            }
            const result = logger.rotate({ maxEntries: 5, maxAgeDays: 365 });
            (0, vitest_1.expect)(result.deleted).toBe(5);
            const remaining = db.prepare('SELECT COUNT(*) as c FROM error_log').get();
            (0, vitest_1.expect)(remaining.c).toBe(5);
        });
    });
    (0, vitest_1.describe)('migrateSummarizerLog', () => {
        (0, vitest_1.it)('should parse summarizer.log format', () => {
            const logContent = [
                '2026-06-01T12:00:00.000Z FAIL codex/gpt-5: timeout=600s exit=null',
                '2026-06-01T12:01:00.000Z FAIL opencode/deepseek-v4-flash: exit=1 stderr=crash',
                '2026-06-01T12:02:00.000Z HEURISTIC batch 3: Prior themes: deployment...',
            ].join('\n');
            const imported = logger.migrateSummarizerLog(logContent);
            (0, vitest_1.expect)(imported).toBe(3);
            const rows = db.prepare('SELECT * FROM error_log ORDER BY timestamp').all();
            (0, vitest_1.expect)(rows).toHaveLength(3);
            (0, vitest_1.expect)(rows[0].tool).toBe('summarizer/codex/gpt-5');
            (0, vitest_1.expect)(rows[0].error).toContain('FAIL');
            (0, vitest_1.expect)(rows[2].tool).toBe('summarizer');
            (0, vitest_1.expect)(rows[2].error).toContain('HEURISTIC');
        });
        (0, vitest_1.it)('should handle empty log', () => {
            const imported = logger.migrateSummarizerLog('');
            (0, vitest_1.expect)(imported).toBe(0);
        });
        (0, vitest_1.it)('should handle malformed lines gracefully', () => {
            const logContent = 'garbage line\n2026-06-01T12:00:00.000Z FAIL tool: err';
            const imported = logger.migrateSummarizerLog(logContent);
            (0, vitest_1.expect)(imported).toBe(1); // only the valid line
        });
    });
    (0, vitest_1.describe)('importEntries', () => {
        (0, vitest_1.it)('should bulk-import entries', () => {
            const count = logger.importEntries([
                { timestamp: '2026-06-01T00:00:00.000Z', tool: 'cli-a', error: 'e1' },
                { timestamp: '2026-06-01T01:00:00.000Z', tool: 'cli-b', error: 'e2', stack: 'trace' },
            ]);
            (0, vitest_1.expect)(count).toBe(2);
            const rows = db.prepare('SELECT COUNT(*) as c FROM error_log').get();
            (0, vitest_1.expect)(rows.c).toBe(2);
        });
    });
});
//# sourceMappingURL=error-log.test.js.map