// ErrorLogger Tests — v0.1.0-alpha

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ErrorLogger } from '../error-log.js';
import { runMigrations } from '../schema.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

let db: Database.Database;
let logger: ErrorLogger;

beforeEach(() => {
  db = createTestDb();
  logger = new ErrorLogger(db, { maxEntries: 100, maxAgeDays: 30 });
});

afterEach(() => {
  db.close();
});

describe('ErrorLogger', () => {
  describe('logError', () => {
    it('should log an error entry', () => {
      logger.logError({
        tool: 'tim_read',
        error: 'Entry not found',
      });

      const row = db.prepare('SELECT * FROM error_log').get() as any;
      expect(row).toBeTruthy();
      expect(row.tool).toBe('tim_read');
      expect(row.error).toBe('Entry not found');
      expect(row.timestamp).toBeTruthy();
      expect(row.args_json).toBe('{}');
      expect(row.stack).toBeNull();
      expect(row.session_id).toBeNull();
    });

    it('should log with all fields', () => {
      logger.logError({
        tool: 'tim_write',
        args: { content: 'test' },
        error: 'DB error',
        stack: 'Error: DB error\n  at foo.ts:10',
        sessionId: 'ses-123',
      });

      const row = db.prepare('SELECT * FROM error_log').get() as any;
      expect(row.tool).toBe('tim_write');
      expect(row.args_json).toContain('test');
      expect(row.error).toBe('DB error');
      expect(row.stack).toContain('foo.ts:10');
      expect(row.session_id).toBe('ses-123');
    });

    it('should handle circular JSON args gracefully', () => {
      const circ: any = { name: 'circ' };
      circ.self = circ;

      expect(() => {
        logger.logError({ tool: 'test', args: circ, error: 'circular' });
      }).not.toThrow();

      const row = db.prepare('SELECT * FROM error_log').get() as any;
      expect(row.args_json).toBe('{}');
    });

    it('should not throw on DB errors (self-healing)', () => {
      db.close(); // kill DB
      expect(() => {
        logger.logError({ tool: 'test', error: 'after close' });
      }).not.toThrow();
    });
  });

  describe('getStats', () => {
    it('should return empty stats when no errors', () => {
      const stats = logger.getStats({ hours: 24 });
      expect(stats.totalErrors).toBe(0);
      expect(stats.errorRate).toBe(0);
      expect(stats.topErrors).toEqual([]);
      expect(stats.byTool).toEqual([]);
      expect(stats.alerts).toEqual([]);
    });

    it('should return stats with errors', () => {
      logger.logError({ tool: 'tim_read', error: 'not found' });
      logger.logError({ tool: 'tim_read', error: 'not found' });
      logger.logError({ tool: 'tim_write', error: 'DB locked' });

      const stats = logger.getStats({ hours: 24, limit: 10 });
      expect(stats.totalErrors).toBe(3);
      expect(stats.topErrors).toHaveLength(2); // 2 unique errors
      expect(stats.topErrors[0].error).toBe('not found');
      expect(stats.topErrors[0].count).toBe(2);
      expect(stats.byTool).toHaveLength(2);
    });

    it('should respect hours filter', () => {
      // Insert error with old timestamp
      const oldDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO error_log (timestamp, tool, args_json, error)
        VALUES (?, 'tim_old', '{}', 'old error')
      `).run(oldDate);

      logger.logError({ tool: 'tim_new', error: 'new error' });

      const stats = logger.getStats({ hours: 24 });
      expect(stats.totalErrors).toBe(1); // only "new error"
    });
  });

  describe('getAlertThresholds', () => {
    it('should flag >5 identical errors in 1h', () => {
      const error = 'Connection refused';
      for (let i = 0; i < 6; i++) {
        logger.logError({ tool: 'tim_sync', error });
      }

      const stats = logger.getStats({ hours: 1 });
      expect(stats.alerts).toHaveLength(1);
      expect(stats.alerts[0]).toContain('Connection refused');
      expect(stats.alerts[0]).toContain('6x');
    });

    it('should not flag <=5 identical errors', () => {
      const error = 'Timeout';
      for (let i = 0; i < 5; i++) {
        logger.logError({ tool: 'tim_read', error });
      }

      const stats = logger.getStats({ hours: 1 });
      expect(stats.alerts).toHaveLength(0);
    });
  });

  describe('rotate', () => {
    it('should delete old entries by age', () => {
      const oldDate = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
      db.prepare(`
        INSERT INTO error_log (timestamp, tool, args_json, error)
        VALUES (?, 'tim_old', '{}', 'old')
      `).run(oldDate);

      logger.logError({ tool: 'tim_new', error: 'new' });

      const result = logger.rotate({ maxAgeDays: 30 });
      expect(result.deleted).toBe(1);

      const remaining = db.prepare('SELECT COUNT(*) as c FROM error_log').get() as any;
      expect(remaining.c).toBe(1);
    });

    it('should delete oldest entries when exceeding maxEntries', () => {
      for (let i = 0; i < 10; i++) {
        logger.logError({ tool: 'test', error: `err ${i}` });
      }

      const result = logger.rotate({ maxEntries: 5, maxAgeDays: 365 });
      expect(result.deleted).toBe(5);

      const remaining = db.prepare('SELECT COUNT(*) as c FROM error_log').get() as any;
      expect(remaining.c).toBe(5);
    });
  });

  describe('migrateSummarizerLog', () => {
    it('should parse summarizer.log format', () => {
      const logContent = [
        '2026-06-01T12:00:00.000Z FAIL codex/gpt-5: timeout=600s exit=null',
        '2026-06-01T12:01:00.000Z FAIL opencode/deepseek-v4-flash: exit=1 stderr=crash',
        '2026-06-01T12:02:00.000Z HEURISTIC batch 3: Prior themes: deployment...',
      ].join('\n');

      const imported = logger.migrateSummarizerLog(logContent);
      expect(imported).toBe(3);

      const rows = db.prepare('SELECT * FROM error_log ORDER BY timestamp').all() as any[];
      expect(rows).toHaveLength(3);
      expect(rows[0].tool).toBe('summarizer/codex/gpt-5');
      expect(rows[0].error).toContain('FAIL');
      expect(rows[2].tool).toBe('summarizer');
      expect(rows[2].error).toContain('HEURISTIC');
    });

    it('should handle empty log', () => {
      const imported = logger.migrateSummarizerLog('');
      expect(imported).toBe(0);
    });

    it('should handle malformed lines gracefully', () => {
      const logContent = 'garbage line\n2026-06-01T12:00:00.000Z FAIL tool: err';
      const imported = logger.migrateSummarizerLog(logContent);
      expect(imported).toBe(1); // only the valid line
    });
  });

  describe('importEntries', () => {
    it('should bulk-import entries', () => {
      const count = logger.importEntries([
        { timestamp: '2026-06-01T00:00:00.000Z', tool: 'cli-a', error: 'e1' },
        { timestamp: '2026-06-01T01:00:00.000Z', tool: 'cli-b', error: 'e2', stack: 'trace' },
      ]);
      expect(count).toBe(2);

      const rows = db.prepare('SELECT COUNT(*) as c FROM error_log').get() as any;
      expect(rows.c).toBe(2);
    });
  });
});
