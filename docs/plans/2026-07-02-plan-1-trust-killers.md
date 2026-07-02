# Plan 1: Trust-Killers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four "tool lies to the agent" bugs: non-functional `tim_suppress`, one-way `irrelevant` flag, FTS crashes on everyday tokens, and the dead `sections` filter in `load_project`.

**Architecture:** All four fixes are localized to `tim-store/src/store.ts` plus small companion edits in `tim-core` (option types) and `tim-mcp/src/server.ts` (zod schema + `tim_read` filter). No schema migration needed — the `suppressed` table already exists.

**Tech Stack:** TypeScript, better-sqlite3, FTS5, Vitest, zod.

## Global Constraints

- Monorepo build: `npm run build` at repo root (tsc project references). Run tests per package: `npx vitest run <file>` from the package dir, or `npm test` at root.
- Never touch `~/.tim/tim.db`. All tests use temp DB paths (`/tmp/tim-test-*.db` pattern, see existing tests).
- Do not change public API signatures except as specified (additive options only).
- Existing test suite must stay green. `packages/tim-store/src/__tests__/search-sanitization.test.ts` expectations WILL change in Task 3 — that is intended.
- Commit after each task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Enforce suppression in search() and loadProject(), and in tim_read at MCP level

**Files:**
- Modify: `packages/tim-store/src/store.ts` (search ~line 1283, loadProject ~line 410, suppression section ~line 1812)
- Modify: `packages/tim-mcp/src/server.ts` (`tim_read` handler, `case 'tim_read'`)
- Test: `packages/tim-store/src/__tests__/suppress-enforcement.test.ts` (new)

**Design decision (do not deviate):** Suppression is enforced in the retrieval-facing paths only: `TimStore.search()`, `TimStore.loadProject()`, and the `tim_read` MCP handler. It is deliberately NOT enforced inside `TimStore.read()` itself, because `read()` is internal plumbing used by session logging, project resolution, and rollup — a suppress pattern accidentally matching a session node must not break the summarizer pipeline.

**Interfaces:**
- Produces: `TimStore.loadActiveSuppressPatterns(): string[]` (private), `TimStore.matchesSuppressed(patterns: string[], entry: { title: string; content: string }): boolean` (private static). Existing public `isSuppressed(content: string): Promise<boolean>` stays unchanged (used by the MCP handler).

- [ ] **Step 1: Write the failing test**

Create `packages/tim-store/src/__tests__/suppress-enforcement.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('suppress enforcement', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-suppress-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('hides suppressed entries from search()', async () => {
    await store.write('Secret token rotation\nThe API key rotates weekly.');
    await store.write('Public docs page\nNothing sensitive here.');
    await store.suppress('token rotation', 'security');

    const results = await store.search({ query: 'rotation weekly' });
    expect(results.find(e => e.title.includes('Secret'))).toBeUndefined();

    const publicHit = await store.search({ query: 'docs page' });
    expect(publicHit.length).toBeGreaterThan(0);
  });

  it('hides suppressed entries (and their subtrees) from loadProject()', async () => {
    const project = await store.createProject('P9001', { content: 'P9001 Test' });
    const section = await store.write('Poison Section\nold approach', {
      parentId: project.id,
    });
    await store.write('Child of poison\ndetail', { parentId: section.id });
    await store.write('Clean Section\ngood stuff', { parentId: project.id });
    await store.suppress('old approach', 'deprecated');

    const result = await store.loadProject('P9001');
    expect(result).not.toBeNull();
    const titles = result!.children.map(c => c.title);
    expect(titles).toContain('Clean Section');
    expect(titles).not.toContain('Poison Section');
    expect(titles).not.toContain('Child of poison');
  });

  it('expired suppress patterns do not hide entries', async () => {
    await store.write('Ephemeral thing\ntemporary content');
    // 1-minute TTL, then simulate expiry by rewriting expires_at into the past
    await store.suppress('temporary content', 'test', '1m');
    store.getDb().prepare(
      "UPDATE suppressed SET expires_at = '2000-01-01T00:00:00.000Z'",
    ).run();

    const results = await store.search({ query: 'temporary content' });
    expect(results.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/suppress-enforcement.test.ts`
Expected: FAIL — suppressed entries still appear in `search()` and `loadProject()` results.

- [ ] **Step 3: Implement enforcement in tim-store**

In `packages/tim-store/src/store.ts`, add two private helpers next to the existing Suppression section (~line 1812):

```typescript
  /** Active (non-expired) suppress patterns, lowercased. Loaded once per retrieval call. */
  private loadActiveSuppressPatterns(): string[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      'SELECT pattern FROM suppressed WHERE expires_at IS NULL OR expires_at > ?',
    ).all(now) as { pattern: string }[];
    return rows.map(r => r.pattern.toLowerCase());
  }

  private static matchesSuppressed(
    patterns: string[],
    entry: { title: string; content: string },
  ): boolean {
    if (patterns.length === 0) return false;
    const text = `${entry.title}\n${entry.content}`.toLowerCase();
    return patterns.some(p => text.includes(p));
  }
```

Change `search()` (~line 1283) to filter both the FTS results and the merged project hit:

```typescript
  async search(options: SearchOptions): Promise<Entry[]> {
    const topK = options.topK ?? 10;
    const patterns = this.loadActiveSuppressPatterns();
    const fts = (await this.searchFts(options.query, topK))
      .filter(e => !TimStore.matchesSuppressed(patterns, e));
    // Labels/aliases live in metadata, not the FTS corpus. Merge a direct project hit.
    // Broader fix: index metadata.label + aliases in fts_entries (migration + triggers).
    const resolved = await this.resolveProjectLabel(options.query);
    if (resolved.status === 'found') {
      const row = this.db.prepare(`
        SELECT * FROM entries
        WHERE json_extract(metadata, '$.kind') = 'project'
          AND json_extract(metadata, '$.label') = ?
          AND irrelevant = 0
          AND tombstoned_at IS NULL
      `).get(resolved.label) as RowEntry | undefined;
      const proj = row ? rowToEntry(row) : null;
      if (proj && !TimStore.matchesSuppressed(patterns, proj) && !fts.some(e => e.id === proj.id)) {
        return [proj, ...fts].slice(0, topK);
      }
    }
    return fts;
  }
```

In `loadProject()` (~line 410), load patterns once before `loadChildren` is defined, and skip suppressed subtrees. Inside the `for (const row of childEntries)` loop, after `const child = rowToEntry(row);` and BEFORE `children.push(child);` insert:

```typescript
        if (TimStore.matchesSuppressed(suppressPatterns, child)) continue;
```

and above the `matchesSection` definition add:

```typescript
    const suppressPatterns = this.loadActiveSuppressPatterns();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/suppress-enforcement.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Enforce in tim_read MCP handler**

In `packages/tim-mcp/src/server.ts`, find `case 'tim_read':`. In the branch that reads a single entry by `id` (the one calling `s.read(id, readOpts)`), after the entry is fetched and found non-null, add:

```typescript
          if (entry && await s.isSuppressed(`${entry.title}\n${entry.content}`)) {
            return {
              content: [{ type: 'text', text: `Entry suppressed: ${id}` }],
              isError: true,
            };
          }
```

Also update the `tim_suppress` tool description in the ListTools registration (~line 1161) so it accurately says: `'Suppress entries matching a pattern: hidden from tim_search, tim_read, and tim_load_project. Optional TTL (e.g. "24h", "7d").'`

- [ ] **Step 6: Run full tim-store + tim-mcp suites**

Run: `cd packages/tim-store && npx vitest run && cd ../tim-mcp && npm run build && npx vitest run`
Expected: PASS. If any existing test wrote content that collides with a suppress pattern from another test, check for shared DB paths (each test must use its own temp DB).

- [ ] **Step 7: Commit**

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/suppress-enforcement.test.ts packages/tim-mcp/src/server.ts
git commit -m "fix(tim-store, tim-mcp): enforce tim_suppress in search/loadProject/tim_read"
```

---

### Task 2: Make update() symmetric — irrelevant and tombstone can be cleared

**Files:**
- Modify: `packages/tim-store/src/store.ts:1165-1166` (the `updated` object in `update()`)
- Modify: `packages/tim-mcp/src/server.ts:159` (`TimUpdateSchema`) and the hand-written `tim_update` ListTools inputSchema (~line 1078)
- Test: `packages/tim-store/src/__tests__/update-symmetric.test.ts` (new)

**Interfaces:**
- Consumes: existing `TimStore.update(id, patch: Partial<Entry>)`.
- Produces: `update(id, { irrelevant: false })` un-hides a soft-deleted entry; `update(id, { tombstonedAt: null })` clears a tombstone. MCP `tim_update` gains an `irrelevant?: boolean` parameter.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-store/src/__tests__/update-symmetric.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('update() symmetric flags', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-updsym-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('update(irrelevant:false) restores a soft-deleted entry', async () => {
    const entry = await store.write('Restorable\nbody');
    await store.update(entry.id, { irrelevant: true });
    expect(await store.read(entry.id)).toBeNull();

    await store.update(entry.id, { irrelevant: false });
    const restored = await store.read(entry.id);
    expect(restored).not.toBeNull();
    expect(restored!.irrelevant).toBe(false);
  });

  it('update without irrelevant in patch leaves the flag untouched', async () => {
    const entry = await store.write('Keep flag\nbody');
    await store.update(entry.id, { irrelevant: true });
    await store.update(entry.id, { content: 'Keep flag\nnew body' });
    const row = await store.read(entry.id, { showIrrelevant: true });
    expect(row!.irrelevant).toBe(true);
  });

  it('update(tombstonedAt:null) clears a tombstone', async () => {
    const entry = await store.write('Untombable\nbody');
    await store.delete(entry.id, true); // hard delete = tombstone
    await store.update(entry.id, { tombstonedAt: null });
    const restored = await store.read(entry.id);
    expect(restored).not.toBeNull();
    expect(restored!.tombstonedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/update-symmetric.test.ts`
Expected: FAIL — tests 1 and 3 fail (flags are one-way today).

- [ ] **Step 3: Fix the two lines in update()**

In `packages/tim-store/src/store.ts`, inside `update()`, replace:

```typescript
      irrelevant: patch.irrelevant ? 1 : existing.irrelevant,
      tombstoned_at: patch.tombstonedAt ?? existing.tombstoned_at,
```

with:

```typescript
      irrelevant: patch.irrelevant === undefined ? existing.irrelevant : (patch.irrelevant ? 1 : 0),
      tombstoned_at: patch.tombstonedAt === undefined ? existing.tombstoned_at : patch.tombstonedAt,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/update-symmetric.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Expose irrelevant on tim_update**

In `packages/tim-mcp/src/server.ts`, `TimUpdateSchema` (~line 159), add one field:

```typescript
  irrelevant: z.boolean().optional(),
```

In the hand-written ListTools inputSchema for `tim_update` (~line 1078), add to `properties`:

```typescript
            irrelevant: { type: 'boolean', description: 'Set false to restore a soft-deleted entry, true to soft-delete' },
```

The handler already spreads the parsed patch into `s.update(id, patch as Partial<Entry>)` — no handler change needed. Deliberately do NOT expose `tombstonedAt` via MCP (restore-from-tombstone stays a curator/CLI concern).

- [ ] **Step 6: Run suites and commit**

Run: `npm run build && cd packages/tim-store && npx vitest run && cd ../tim-mcp && npx vitest run`
Expected: PASS.

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/update-symmetric.test.ts packages/tim-mcp/src/server.ts
git commit -m "fix(tim-store, tim-mcp): make irrelevant/tombstone flags clearable via update"
```

---

### Task 3: FTS sanitizer — replace character blocklist with per-token quoting

**Files:**
- Modify: `packages/tim-store/src/store.ts:39-68` (`sanitizeFtsQuery`)
- Modify: `packages/tim-store/src/__tests__/search-sanitization.test.ts` (update expectations to quoted format)

**Design:** Every whitespace-separated token is emitted as an FTS5 quoted string (`"token"`, embedded `"` stripped). Inside quotes, FTS5 treats operators (AND/OR/NOT/NEAR) and punctuation (`. / @ + % # -`) as literal text to tokenize — the whole blocklist arms race disappears. Column filters `title:`/`content:`/`tags:` survive as `column:"value"`. Tokens with no alphanumeric content are dropped (a fully-punctuation quoted string can error or match nothing).

**Interfaces:**
- Produces: `sanitizeFtsQuery(query: string): string` — same signature, new output format: `foo bar.ts` → `"foo" "bar.ts"`; `title:fix` → `title:"fix"`; `kind:summary` → `"kind" "summary"`; returns `''` when nothing survives.

- [ ] **Step 1: Write/adjust the tests first**

In `packages/tim-store/src/__tests__/search-sanitization.test.ts`, replace assertions on sanitizer OUTPUT with the quoted forms, and add crash-regression cases. New/updated cases (keep the file's existing structure and any end-to-end search tests, adjusting expected sanitizer strings):

```typescript
import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery } from '../store.js';

describe('sanitizeFtsQuery (quoting strategy)', () => {
  it('quotes plain tokens', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
  });

  it('handles dots, slashes, plus, at, percent without crashing FTS5', () => {
    expect(sanitizeFtsQuery('store.ts')).toBe('"store.ts"');
    expect(sanitizeFtsQuery('src/store.ts')).toBe('"src/store.ts"');
    expect(sanitizeFtsQuery('C++')).toBe('"C++"');
    expect(sanitizeFtsQuery('user@example.com')).toBe('"user@example.com"');
    expect(sanitizeFtsQuery('100%')).toBe('"100%"');
  });

  it('keeps real column filters, quotes the value', () => {
    expect(sanitizeFtsQuery('title:fix')).toBe('title:"fix"');
    expect(sanitizeFtsQuery('content:store.ts')).toBe('content:"store.ts"');
  });

  it('splits bogus column filters into two terms', () => {
    expect(sanitizeFtsQuery('kind:summary')).toBe('"kind" "summary"');
    expect(sanitizeFtsQuery('task:true')).toBe('"task" "true"');
  });

  it('treats operator words as literal terms (quoted)', () => {
    expect(sanitizeFtsQuery('foo AND bar')).toBe('"foo" "AND" "bar"');
  });

  it('strips embedded double quotes', () => {
    expect(sanitizeFtsQuery('say "hello"')).toBe('"say" "hello"');
  });

  it('drops tokens with no alphanumeric content, returns empty for pure noise', () => {
    expect(sanitizeFtsQuery('--- *** ^^')).toBe('');
    expect(sanitizeFtsQuery('')).toBe('');
  });
});
```

Also add an end-to-end crash regression (same file or the existing e2e block): create a temp store, write an entry containing `store.ts`, and assert `await store.search({ query: 'store.ts' })` returns it without throwing.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd packages/tim-store && npx vitest run src/__tests__/search-sanitization.test.ts`
Expected: FAIL — current implementation emits unquoted tokens and mangles `store.ts`.

- [ ] **Step 3: Rewrite sanitizeFtsQuery**

Replace the body of `sanitizeFtsQuery` in `packages/tim-store/src/store.ts` (keep the doc comment, update it to describe the quoting strategy):

```typescript
export function sanitizeFtsQuery(query: string): string {
  if (!query) return '';
  // FTS5 columns defined in schema.ts — the ONLY names a `token:value`
  // filter may reference. Anything else would crash ("no such column: X").
  const REAL_COLUMNS = new Set(['title', 'content', 'tags']);
  const out: string[] = [];

  const quoteTerm = (term: string): string | null => {
    // Embedded double quotes would terminate the FTS5 string — strip them.
    const cleaned = term.replace(/"/g, ' ').trim();
    // A quoted string with no tokenizable content matches nothing (or errors).
    if (!/[0-9A-Za-zÀ-￿]/.test(cleaned)) return null;
    return `"${cleaned}"`;
  };

  for (const raw of query.split(/\s+/)) {
    if (!raw) continue;
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):(.+)$/);
    if (m && REAL_COLUMNS.has(m[1].toLowerCase())) {
      const q = quoteTerm(m[2]);
      if (q) out.push(`${m[1].toLowerCase()}:${q}`);
      continue;
    }
    if (m) {
      // Bogus column filter: keep both sides as plain search terms.
      const a = quoteTerm(m[1]);
      if (a) out.push(a);
      const b = quoteTerm(m[2]);
      if (b) out.push(b);
      continue;
    }
    const q = quoteTerm(raw);
    if (q) out.push(q);
  }

  // Implicit FTS5 AND — quoted terms joined by space.
  return out.join(' ');
}
```

Note: inside quotes, operator words are literal, so the old AND/OR/NOT/NEAR filter is intentionally gone. A user phrase originally quoted across spaces (`"foo bar"`) degrades to `"foo" "bar"` (AND instead of phrase) — acceptable, document in the doc comment.

- [ ] **Step 4: Run the sanitization tests, then the whole tim-store suite**

Run: `cd packages/tim-store && npx vitest run src/__tests__/search-sanitization.test.ts && npx vitest run`
Expected: PASS. Other tests asserting old sanitizer output must be updated to the quoted format — grep with `grep -rn "sanitizeFtsQuery" src/__tests__/` and fix expectations only (never the assertion intent).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/search-sanitization.test.ts
git commit -m "fix(tim-store): FTS sanitizer quotes tokens instead of blocklisting chars"
```

---

### Task 4: load_project sections filter matches section titles

**Files:**
- Modify: `packages/tim-store/src/store.ts:426-430` (`matchesSection` inside `loadProject`)
- Test: `packages/tim-store/src/__tests__/load-project-sections.test.ts` (new)

**Interfaces:**
- Produces: `loadProject(label, { sections: ['Tasks'] })` returns the section whose `title` is `Tasks` (case-insensitive) plus its subtree; id/label matching still works.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-store/src/__tests__/load-project-sections.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

describe('loadProject sections filter', () => {
  let store: TimStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/tim-sections-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new TimStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('filters direct children by section title (case-insensitive)', async () => {
    const project = await store.createProject('P9002', { content: 'P9002 Test' });
    const tasks = await store.write('Tasks\n', { parentId: project.id });
    await store.write('Task one\ndo it', { parentId: tasks.id });
    await store.write('Ideas\n', { parentId: project.id });

    const result = await store.loadProject('P9002', { sections: ['tasks'] });
    expect(result).not.toBeNull();
    const titles = result!.children.map(c => c.title);
    expect(titles).toContain('Tasks');
    expect(titles).toContain('Task one');
    expect(titles).not.toContain('Ideas');
  });

  it('still matches by entry id', async () => {
    const project = await store.createProject('P9003', { content: 'P9003 Test' });
    const tasks = await store.write('Tasks\n', { parentId: project.id });
    await store.write('Ideas\n', { parentId: project.id });

    const result = await store.loadProject('P9003', { sections: [tasks.id] });
    expect(result!.children.map(c => c.title)).toEqual(expect.arrayContaining(['Tasks']));
    expect(result!.children.map(c => c.title)).not.toContain('Ideas');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/load-project-sections.test.ts`
Expected: FAIL — first test returns empty children (title never matched).

- [ ] **Step 3: Fix matchesSection**

In `packages/tim-store/src/store.ts` (~line 426), replace:

```typescript
    const matchesSection = (entry: Entry): boolean => {
      if (!sections?.length) return true;
      const entryLabel = entry.metadata.label as string | undefined;
      return sections.some(section => section === entry.id || section === entryLabel);
    };
```

with:

```typescript
    const matchesSection = (entry: Entry): boolean => {
      if (!sections?.length) return true;
      const entryLabel = entry.metadata.label as string | undefined;
      const entryTitle = entry.title.toLowerCase();
      return sections.some(section =>
        section === entry.id ||
        section === entryLabel ||
        section.toLowerCase() === entryTitle,
      );
    };
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tim-store && npx vitest run src/__tests__/load-project-sections.test.ts && npx vitest run`
Expected: PASS, full suite green.

- [ ] **Step 5: Update stale docs and commit**

In `docs/tim-capabilities.md` §8, remove/strike the "sections-Filter matcht nur id/label" known issue (mark as fixed with today's date, following how the four already-fixed §8 items were handled).

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/load-project-sections.test.ts docs/tim-capabilities.md
git commit -m "fix(tim-store): load_project sections filter matches section titles"
```
