# Plan 2: Ops-Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mid-migration crash can no longer brick the DB (transactional migrations + automatic pre-migration backup), and `health()`/`tim doctor` reports real dangling-parent orphans instead of counting every edge-less leaf.

**Architecture:** All changes live in `packages/tim-store/src/schema.ts` (migration runner) and `packages/tim-store/src/store.ts` (`health()`). The backup is a plain `fs.copyFileSync` of the DB file after a WAL checkpoint — no dependency on the tim-cli `snapshot` command (wrong dependency direction: tim-cli depends on tim-store).

**Tech Stack:** TypeScript, better-sqlite3, node:fs, Vitest.

## Global Constraints

- Never touch `~/.tim/tim.db`. Tests use temp DB paths.
- `runMigrations` gains an optional second parameter for testability; the default behavior for all existing callers is unchanged.
- Backup failure ABORTS the migration (throws) — a migration without a safety net is the bug we're fixing. Escape hatch: env `TIM_SKIP_MIGRATION_BACKUP=1`.
- Prerequisite ordering: land this BEFORE any Phase-0.7 schema work (new columns for summary-first reads etc.).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Transactional migrations with per-migration version bump + pre-migration backup

**Files:**
- Modify: `packages/tim-store/src/schema.ts:174-198` (`runMigrations`)
- Test: `packages/tim-store/src/__tests__/migrations.test.ts` (new)

**Interfaces:**
- Consumes: module-level `MIGRATIONS` array (unchanged).
- Produces: `runMigrations(db: Database.Database, migrations: { version: number; sql: string }[] = MIGRATIONS): void`. Each migration runs in its own transaction; `_schema_version` is written inside that same transaction. A `<dbPath>.pre-migration-v<N>.bak` file is created before the first pending migration when upgrading an existing DB.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/migrations.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { runMigrations, MIGRATIONS } from '../schema.js';

function tmpDb(): string {
  return `/tmp/tim-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

const cleanupPaths: string[] = [];
afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + suffix); } catch { /* ignore */ }
    }
  }
});

describe('runMigrations', () => {
  it('a failing migration rolls back completely and stays retryable', () => {
    const dbPath = tmpDb();
    cleanupPaths.push(dbPath);
    const db = new Database(dbPath);

    const v1 = { version: 1, sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY);' };
    // v2 does a real ALTER, then fails — the classic brick scenario.
    const v2bad = {
      version: 2,
      sql: 'ALTER TABLE t ADD COLUMN extra TEXT; INSERT INTO nonexistent VALUES (1);',
    };
    const v2good = { version: 2, sql: 'ALTER TABLE t ADD COLUMN extra TEXT;' };

    runMigrations(db, [v1]);
    expect(() => runMigrations(db, [v1, v2bad])).toThrow();

    // Version must still be 1 and the ALTER rolled back — retry must NOT
    // die with "duplicate column name".
    const version = (db.prepare('SELECT version FROM _schema_version').get() as { version: number }).version;
    expect(version).toBe(1);
    expect(() => runMigrations(db, [v1, v2good])).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('extra');
    db.close();
  });

  it('creates a backup file before migrating an existing DB', () => {
    const dbPath = tmpDb();
    cleanupPaths.push(dbPath);
    const db = new Database(dbPath);
    runMigrations(db); // fresh DB — full schema, no backup expected
    expect(fs.existsSync(`${dbPath}.pre-migration-v0.bak`)).toBe(false);

    // Simulate an upgrade: rewind version, add a fake future migration.
    db.prepare('UPDATE _schema_version SET version = ?').run(MIGRATIONS.length - 1);
    const future = {
      version: MIGRATIONS[MIGRATIONS.length - 1].version,
      sql: 'CREATE TABLE IF NOT EXISTS mig_probe (id INTEGER);',
    };
    runMigrations(db, [...MIGRATIONS.slice(0, -1), future]);

    const backupPath = `${dbPath}.pre-migration-v${MIGRATIONS.length - 1}.bak`;
    cleanupPaths.push(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    db.close();
  });

  it('skips backup on a fresh (version 0) DB', () => {
    const dbPath = tmpDb();
    cleanupPaths.push(dbPath);
    const db = new Database(dbPath);
    runMigrations(db);
    const backups = fs.readdirSync('/tmp').filter(f => f.startsWith(dbPath.split('/').pop()!) && f.includes('.bak'));
    expect(backups).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tim-store && npx vitest run src/__tests__/migrations.test.ts`
Expected: FAIL — `runMigrations` doesn't accept a migrations parameter yet; version handling isn't per-migration; no backup file.

- [ ] **Step 3: Rewrite runMigrations**

In `packages/tim-store/src/schema.ts`, add `import fs from 'node:fs';` at the top, export `MIGRATIONS` (already exported), and replace `runMigrations`:

```typescript
export function runMigrations(
  db: Database.Database,
  migrations: { version: number; sql: string }[] = MIGRATIONS,
): void {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)`);

  const current = db.prepare('SELECT version FROM _schema_version').get() as
    { version: number } | undefined;
  const currentVersion = current?.version ?? 0;

  const pending = migrations.filter(m => m.version > currentVersion);
  if (pending.length === 0) return;

  backupBeforeMigration(db, currentVersion);

  for (const migration of pending) {
    // One transaction per migration: SQLite DDL is transactional, so a crash
    // or SQL error rolls back both the DDL and the version bump — the DB
    // stays at the previous version and the migration is safely retryable.
    db.transaction(() => {
      db.exec(migration.sql);
      const row = db.prepare('SELECT version FROM _schema_version').get();
      if (row) {
        db.prepare('UPDATE _schema_version SET version = ?').run(migration.version);
      } else {
        db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(migration.version);
      }
    })();
  }
}

function backupBeforeMigration(db: Database.Database, fromVersion: number): void {
  // Fresh DB (version 0) has nothing to lose; in-memory DBs have no file.
  if (fromVersion === 0) return;
  const dbPath = db.name;
  if (!dbPath || dbPath === ':memory:') return;
  if (process.env.TIM_SKIP_MIGRATION_BACKUP === '1') return;

  const backupPath = `${dbPath}.pre-migration-v${fromVersion}.bak`;
  try {
    // Fold WAL into the main file so the copy is complete on its own.
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, backupPath);
  } catch (err) {
    throw new Error(
      `Pre-migration backup failed (${backupPath}): ${(err as Error).message}. ` +
      'Refusing to migrate without a backup. Set TIM_SKIP_MIGRATION_BACKUP=1 to override.',
    );
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tim-store && npx vitest run src/__tests__/migrations.test.ts && npx vitest run`
Expected: PASS, full suite green (every existing test creates a fresh DB → version 0 → no backup, no behavior change).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/schema.ts packages/tim-store/src/__tests__/migrations.test.ts
git commit -m "fix(tim-store): transactional migrations with pre-migration backup"
```

---

### Task 2: health() orphan metric counts real dangling parents

**Files:**
- Modify: `packages/tim-store/src/store.ts:1624-1634` (orphan query in `health()`)
- Test: `packages/tim-store/src/__tests__/health-metrics.test.ts` (new)

**Background:** Today's query counts every entry that has no children AND no edges as an "orphan" — on the live DB that yields 7381 "orphans" out of 2916 visible entries (leaves are normal, not orphans). The real pathology is an entry whose `parent_id` points at a missing or tombstoned entry.

**Interfaces:**
- Produces: `HealthReport.orphanEntries` = count of live entries whose `parent_id` references a missing/tombstoned parent. `brokenLinks` semantics unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-store/src/__tests__/health-metrics.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('health() orphan metric', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-health-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('an ordinary leaf without edges is NOT an orphan', async () => {
    const root = await store.write('Root\nbody');
    await store.write('Leaf\nbody', { parentId: root.id });
    const report = await store.health();
    expect(report.orphanEntries).toBe(0);
  });

  it('an entry whose parent_id points nowhere IS an orphan', async () => {
    const root = await store.write('Root\nbody');
    const child = await store.write('Child\nbody', { parentId: root.id });
    // Break the link at the raw level (simulates partial deletes/imports).
    store.getDb().prepare('UPDATE entries SET parent_id = ? WHERE id = ?')
      .run('GONE-0000000000000000000000', child.id);
    const report = await store.health();
    expect(report.orphanEntries).toBe(1);
  });

  it('an entry under a tombstoned parent IS an orphan', async () => {
    const root = await store.write('Root\nbody');
    await store.write('Child\nbody', { parentId: root.id });
    await store.delete(root.id, true); // tombstone the parent
    const report = await store.health();
    expect(report.orphanEntries).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/health-metrics.test.ts`
Expected: FAIL — test 1 reports 1 orphan (the leaf), test 2/3 semantics differ.

- [ ] **Step 3: Replace the orphan query**

In `packages/tim-store/src/store.ts`, inside `health()`, replace the orphan block:

```typescript
    // Orphan entries: live entries whose parent_id references a missing or
    // tombstoned parent. Leaves without edges are normal tree nodes, NOT
    // orphans — the old metric counted those and produced numbers larger
    // than the entry count.
    const orphans = this.db.prepare(`
      SELECT COUNT(*) as count FROM entries e
      WHERE e.tombstoned_at IS NULL
        AND e.parent_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM entries p
          WHERE p.id = e.parent_id AND p.tombstoned_at IS NULL
        )
    `).get() as { count: number };
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tim-store && npx vitest run src/__tests__/health-metrics.test.ts && npx vitest run`
Expected: PASS. If an existing test asserted the old orphan semantics, update its expectation and note it in the commit message.

- [ ] **Step 5: Verify against the live DB (read-only) and update docs**

Run: `npm run build && node packages/tim-cli/dist/cli.js doctor`
Expected: orphan count drops from ~7381 to a plausible number (< total entries). Record the before/after numbers in the commit message.

In `docs/tim-capabilities.md` §8, reframe the "5926+ orphans" entry: the old number was a metrics bug; the metric now counts dangling parents.

- [ ] **Step 6: Commit**

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/health-metrics.test.ts docs/tim-capabilities.md
git commit -m "fix(tim-store): health() counts dangling-parent orphans, not edge-less leaves"
```
