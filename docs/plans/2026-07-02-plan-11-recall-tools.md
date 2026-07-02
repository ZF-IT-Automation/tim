# Plan 11: Recall Tools (tim_guard + tim_delta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new read tools: `tim_guard` checks a planned action against known failures/learnings *before* acting (negative memory as guardrail, not just post-mortem), and `tim_delta` answers "what changed in this project since my last session" (a supplement to the full briefing, not a replacement).

**Architecture:** All query logic lives in tim-store (`searchFailures`, `getChangedSince`, `getPreviousSession`); the MCP layer resolves project labels and formats. `tim_guard` is a filtered FTS search over `kind ∈ {error, learning}` entries. `tim_delta` walks the project subtree with a recursive CTE and classifies rows into created/updated/deleted relative to a cutoff; the default cutoff is the previous session's last activity.

**Tech Stack:** TypeScript monorepo, better-sqlite3 (recursive CTE), zod, Vitest.

## Global Constraints

- **Never touch `~/.tim/tim.db`.** All tests use temp DB paths (`fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'))`).
- Prerequisite: **Plan 8 Task 1** (`Entry.updatedAt`) — `tim_delta` reports and sorts by it.
- Ordering: execute **before Plan 4** (tool-registration rewrite). If Plan 4 landed first, register via `TOOL_DEFS` instead of the hand-written ListTools JSON; zod schemas and cases stay identical.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `TimStore.searchFailures`

**Files:**
- Modify: `packages/tim-store/src/store.ts` (new method after `searchFts`, ~line 1338 — after Plan 9's `findSimilar` if that landed)
- Test: `packages/tim-store/src/__tests__/search-failures.test.ts`

**Interfaces:**
- Produces: `TimStore.searchFailures(query: string, opts?: { projectLabel?: string; limit?: number }): Promise<Entry[]>` — consumed by Task 3's `tim_guard` handler.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/search-failures.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('TimStore.searchFailures', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns only error/learning entries matching the query', async () => {
    const err = await store.write(
      'rmapi upload fails with HTTP 400\nBroken since 2025, use sync fox v3 API.',
      { tags: ['#remarkable', '#upload'], metadata: { kind: 'error' } },
    );
    const lesson = await store.write(
      'Lesson: rmapi put is dead\nAlways use the direct upload workaround.',
      { tags: ['#remarkable', '#upload'], metadata: { kind: 'learning' } },
    );
    await store.write(
      'rmapi feature idea upload queue\nNot a failure.',
      { tags: ['#remarkable', '#idea'], metadata: { kind: 'idea' } },
    );

    const hits = await store.searchFailures('rmapi upload');
    const ids = hits.map(e => e.id);
    expect(ids).toContain(err.id);
    expect(ids).toContain(lesson.id);
    expect(ids.length).toBe(2);
  });

  it('scopes to a project when given', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    const inProj = await store.write(
      'Deploy failure on strato\nsystemd unit crashed.',
      { parentId: proj.id, tags: ['#deploy', '#fail'], metadata: { kind: 'error' } },
    );
    await store.write(
      'Deploy failure elsewhere\nDifferent project context.',
      { tags: ['#deploy', '#fail'], metadata: { kind: 'error' } },
    );

    const hits = await store.searchFailures('deploy failure', { projectLabel: 'P0001' });
    expect(hits.map(e => e.id)).toEqual([inProj.id]);
  });

  it('returns empty for a query with no failure matches', async () => {
    await store.write('Happy note\nAll good.', { tags: ['#a', '#b'] });
    expect(await store.searchFailures('happy note')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-store/src/__tests__/search-failures.test.ts`
Expected: FAIL — `store.searchFailures is not a function`.

- [ ] **Step 3: Implement**

In `packages/tim-store/src/store.ts`, after `searchFts` (and after `findSimilar` if present), add:

```typescript
  /**
   * Negative-memory lookup for the tim_guard pre-action check: FTS over
   * the query, filtered to failure knowledge (kind error/learning, or
   * #error/#learning tagged). Over-fetches because most FTS hits are not
   * failures.
   */
  async searchFailures(
    query: string,
    opts: { projectLabel?: string; limit?: number } = {},
  ): Promise<Entry[]> {
    const limit = opts.limit ?? 5;
    const hits = await this.searchFts(query, 50);
    const failures = hits.filter(e => {
      const kind = typeof e.metadata.kind === 'string' ? e.metadata.kind : '';
      return kind === 'error' || kind === 'learning'
        || e.tags.includes('#error') || e.tags.includes('#learning');
    });
    if (!opts.projectLabel) return failures.slice(0, limit);
    return failures
      .filter(e => this.getProjectLabel(e.id) === opts.projectLabel)
      .slice(0, limit);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store/src/__tests__/search-failures.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): searchFailures — negative-memory lookup for pre-action checks"
```

---

### Task 2: `TimStore.getChangedSince` + `getPreviousSession`

**Files:**
- Modify: `packages/tim-store/src/store.ts` (new methods after `getChangedSince` insertion point — put both directly after `searchFailures`)
- Test: `packages/tim-store/src/__tests__/project-delta.test.ts`

**Interfaces:**
- Produces: `TimStore.getChangedSince(projectId: string, sinceIso: string): Promise<{ created: Entry[]; updated: Entry[]; deleted: Entry[] }>` — subtree of `projectId` (the entry ULID of the project root, not the label), excluding the root itself, capped at 500 rows, `updated_at` descending.
- Produces: `TimStore.getPreviousSession(projectId: string, excludeSessionId?: string | null): Promise<Entry | null>` — newest `kind: 'session'` entry in the subtree whose id differs from `excludeSessionId`.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/project-delta.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('project delta', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifies created / updated / deleted relative to the cutoff', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    const before1 = await store.write('Old note\nUnchanged.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });
    const before2 = await store.write('Will change\nOriginal.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });
    const before3 = await store.write('Will die\nBody.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });

    await sleep(10);
    const cutoff = new Date().toISOString();
    await sleep(10);

    const created = await store.write('New note\nFresh.', {
      parentId: proj.id, tags: ['#a', '#b'],
    });
    await store.update(before2.id, { content: 'Will change\nEdited.' });
    await store.delete(before3.id, true); // hard = tombstone

    const delta = await store.getChangedSince(proj.id, cutoff);
    expect(delta.created.map(e => e.id)).toEqual([created.id]);
    expect(delta.updated.map(e => e.id)).toEqual([before2.id]);
    expect(delta.deleted.map(e => e.id)).toEqual([before3.id]);
    // Untouched entry and the project root never appear.
    const all = [...delta.created, ...delta.updated, ...delta.deleted].map(e => e.id);
    expect(all).not.toContain(before1.id);
    expect(all).not.toContain(proj.id);
  });

  it('only sees the given project subtree', async () => {
    const projA = await store.write('A', { metadata: { kind: 'project', label: 'P0001' } });
    const projB = await store.write('B', { metadata: { kind: 'project', label: 'P0002' } });
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    await store.write('In B\nBody.', { parentId: projB.id, tags: ['#a', '#b'] });

    const delta = await store.getChangedSince(projA.id, cutoff);
    expect(delta.created).toEqual([]);
    expect(delta.updated).toEqual([]);
    expect(delta.deleted).toEqual([]);
  });

  it('getPreviousSession finds the newest session excluding the current one', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    const s1 = await store.write('Session one', {
      parentId: proj.id, metadata: { kind: 'session' },
    });
    await sleep(10);
    const s2 = await store.write('Session two', {
      parentId: proj.id, metadata: { kind: 'session' },
    });

    expect((await store.getPreviousSession(proj.id, s2.id))?.id).toBe(s1.id);
    expect((await store.getPreviousSession(proj.id))?.id).toBe(s2.id);
  });

  it('getPreviousSession returns null when there are no sessions', async () => {
    const proj = await store.write('Proj', { metadata: { kind: 'project', label: 'P0001' } });
    expect(await store.getPreviousSession(proj.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-store/src/__tests__/project-delta.test.ts`
Expected: FAIL — `store.getChangedSince is not a function`.

- [ ] **Step 3: Implement**

In `packages/tim-store/src/store.ts`, after `searchFailures`, add:

```typescript
  /**
   * All entries in the project subtree touched since the cutoff, for the
   * tim_delta session briefing supplement. Tombstoned entries appear as
   * "deleted" (their reads are otherwise filtered). Capped at 500 —
   * beyond that, a delta is no longer a briefing.
   */
  async getChangedSince(
    projectId: string,
    sinceIso: string,
  ): Promise<{ created: Entry[]; updated: Entry[]; deleted: Entry[] }> {
    const rows = this.db.prepare(`
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id FROM entries e JOIN sub ON e.parent_id = sub.id
      )
      SELECT e.* FROM entries e
      WHERE e.id IN (SELECT id FROM sub)
        AND e.id != ?
        AND (
          e.created_at >= ?
          OR e.updated_at >= ?
          OR (e.tombstoned_at IS NOT NULL AND e.tombstoned_at >= ?)
        )
      ORDER BY e.updated_at DESC, e.rowid DESC
      LIMIT 500
    `).all(projectId, projectId, sinceIso, sinceIso, sinceIso) as RowEntry[];

    const created: Entry[] = [];
    const updated: Entry[] = [];
    const deleted: Entry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (row.tombstoned_at) deleted.push(entry);
      else if (row.created_at >= sinceIso) created.push(entry);
      else updated.push(entry);
    }
    return { created, updated, deleted };
  }

  /** Newest session entry in the project subtree, excluding the current session. */
  async getPreviousSession(
    projectId: string,
    excludeSessionId?: string | null,
  ): Promise<Entry | null> {
    const row = this.db.prepare(`
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id FROM entries e JOIN sub ON e.parent_id = sub.id
      )
      SELECT e.* FROM entries e
      WHERE e.id IN (SELECT id FROM sub)
        AND json_extract(e.metadata, '$.kind') = 'session'
        AND e.tombstoned_at IS NULL
        AND e.id != COALESCE(?, '')
      ORDER BY e.created_at DESC, e.rowid DESC
      LIMIT 1
    `).get(projectId, excludeSessionId ?? null) as RowEntry | undefined;
    return row ? rowToEntry(row) : null;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS, whole tim-store suite green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): getChangedSince + getPreviousSession for project deltas"
```

---

### Task 3: `tim_guard` and `tim_delta` MCP tools

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` — two zod schemas (near `TimSearchSchema`, ~line 117), two ListTools registrations (after the `tim_search` entry, ~line 1050), two CallTool cases (after `case 'tim_search'`)
- Test: `packages/tim-mcp/src/__tests__/recall-tools.test.ts` (integration via spawned server)

**Interfaces:**
- Consumes: `searchFailures` (Task 1), `getChangedSince` / `getPreviousSession` (Task 2), `Entry.updatedAt` (Plan 8 Task 1), the existing `resolveRoots(s, root)` helper in server.ts (used by tim_read's section path — it resolves the bound/explicit project labels).
- Produces: tool contracts described in the handler code below.

- [ ] **Step 1: Write the failing integration test**

Create `packages/tim-mcp/src/__tests__/recall-tools.test.ts`. Copy the `McpClient` class verbatim from `packages/tim-mcp/src/__tests__/read-search-write-ext.test.ts`, then:

```typescript
describe('tim_guard', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-recall-'));
    client = new McpClient(path.join(dir, 'test.db'));
    await client.initialize();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('warns when a planned action matches a known failure', async () => {
    await client.callTool('tim_write', {
      content: 'rmapi upload fails with HTTP 400\nUse the sync fox v3 API instead.',
      tags: ['#remarkable', '#upload'],
      metadata: { kind: 'error' },
    });

    const res = await client.callTool('tim_guard', {
      action: 'upload the PDF to remarkable via rmapi',
    });
    const body = JSON.parse(res.result!.content[0].text);
    expect(body.status).toBe('warnings');
    expect(body.matches.length).toBe(1);
    expect(body.matches[0].title).toContain('rmapi upload fails');
  });

  it('reports clear when nothing matches', async () => {
    const res = await client.callTool('tim_guard', { action: 'water the office plants' });
    const body = JSON.parse(res.result!.content[0].text);
    expect(body.status).toBe('clear');
  });
});

describe('tim_delta', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-delta-'));
    client = new McpClient(path.join(dir, 'test.db'));
    await client.initialize();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports changes in a project since an explicit cutoff', async () => {
    await client.callTool('tim_create_project', { name: 'Delta Test', label: 'P0001' });
    const cutoff = new Date(Date.now() - 1000).toISOString();
    await client.callTool('tim_write', {
      content: 'Fresh entry\nBody.',
      where: 'P0001/Log',
      tags: ['#a', '#b'],
    });

    const res = await client.callTool('tim_delta', { project: 'P0001', since: cutoff });
    expect(res.result?.isError).toBeFalsy();
    const body = JSON.parse(res.result!.content[0].text);
    expect(body.since).toBe(cutoff);
    expect(body.created.some((e: { title: string }) => e.title === 'Fresh entry')).toBe(true);
  });

  it('errors usefully when no project is given or bound', async () => {
    const res = await client.callTool('tim_delta', {});
    expect(res.result?.isError).toBe(true);
  });
});
```

Note on the fixture: `tim_create_project` seeds default sections — check its schema in server.ts for the exact argument names (`name` / `label` / similar) and the seeded section titles; if `Log` is not among them, use a section that is, or pass `parentId` from the created project's returned structure instead of `where`. The delta assertions must not depend on which sections exist — they only need one fresh entry after the cutoff. Section entries themselves will also appear in `created` if the project was created after the cutoff; that is why the cutoff in the test predates project creation and the assertion uses `.some(...)`, not an exact list.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/recall-tools.test.ts`
Expected: FAIL — unknown tool `tim_guard`.

- [ ] **Step 3: Add schemas**

In `packages/tim-mcp/src/server.ts`, near `TimSearchSchema` (~line 117):

```typescript
const TimGuardSchema = z.object({
  action: z.string().min(3)
    .describe('The planned action, in plain words — e.g. "upload PDF via rmapi"'),
  project: z.string().optional()
    .describe('Scope to a project (label/alias/name). Default: all projects'),
  topK: z.number().min(1).max(20).optional().default(5),
});

const TimDeltaSchema = z.object({
  project: z.string().optional()
    .describe('Project label/alias/name. Default: the bound project'),
  since: z.string().optional()
    .describe('ISO 8601 cutoff. Default: last activity of the previous session, ' +
              'else 7 days ago'),
});
```

- [ ] **Step 4: Add ListTools registrations**

After the `tim_search` registration (~line 1050):

```typescript
      {
        name: 'tim_guard',
        description: 'Pre-action check against negative memory: search known ' +
          'failures (kind=error) and learnings (kind=learning) matching a planned ' +
          'action. Call BEFORE risky/expensive actions — returns warnings with ' +
          'entry ids to tim_read, or status "clear".',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'Planned action in plain words' },
            project: { type: 'string', description: 'Scope to a project (optional)' },
            topK: { type: 'number', default: 5 },
          },
          required: ['action'],
        },
      },
      {
        name: 'tim_delta',
        description: 'What changed in a project since the previous session ' +
          '(created / updated / deleted entries). Supplement to the full ' +
          'project briefing, not a replacement.',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Project label/alias/name (default: bound project)' },
            since: { type: 'string', description: 'ISO 8601 cutoff (default: previous session, else 7d)' },
          },
        },
      },
```

- [ ] **Step 5: Add the CallTool cases**

After `case 'tim_search'`:

```typescript
        case 'tim_guard': {
          const { action, project, topK } = TimGuardSchema.parse(args);
          let projectLabel: string | undefined;
          if (project) {
            const pr = await s.resolveProjectLabel(project);
            if (pr.status !== 'found') {
              return {
                content: [{ type: 'text', text: `project not found: ${project}` }],
                isError: true,
              };
            }
            projectLabel = pr.label;
          }
          const matches = await s.searchFailures(action, { projectLabel, limit: topK });
          if (matches.length === 0) {
            return {
              content: [{
                type: 'text',
                text: formatToolResponse({
                  status: 'clear',
                  message: 'No known failures or learnings match this action.',
                }),
              }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: formatToolResponse({
                status: 'warnings',
                matches: matches.map(e => ({
                  id: e.id,
                  title: e.title,
                  kind: e.metadata.kind,
                  excerpt: e.content.slice(0, 300),
                })),
                hint: 'Known failures/learnings match this action. tim_read the ids ' +
                  'for details before proceeding.',
              }),
            }],
          };
        }

        case 'tim_delta': {
          const { project, since } = TimDeltaSchema.parse(args);
          const roots = await resolveRoots(s, project);
          if (roots.error) {
            return { content: [{ type: 'text', text: roots.error }], isError: true };
          }
          if (!roots.labels || roots.labels.length !== 1) {
            return {
              content: [{
                type: 'text',
                text: 'tim_delta requires a single project (pass project or bind one)',
              }],
              isError: true,
            };
          }
          const projEntry = await s.read(roots.labels[0], { includeChildren: false });
          if (!projEntry) {
            return {
              content: [{ type: 'text', text: `project not found: ${roots.labels[0]}` }],
              isError: true,
            };
          }

          let cutoff = since;
          let baseline = 'explicit since argument';
          if (!cutoff) {
            const currentSession = resolveActiveSessionId({
              markerSession: findMarker(process.cwd(), { walkUp: true })?.marker.session,
            });
            const prev = await s.getPreviousSession(projEntry.id, currentSession ?? null);
            if (prev) {
              cutoff = prev.updatedAt;
              baseline = `previous session ${prev.id} (last activity)`;
            } else {
              cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
              baseline = 'no previous session found — defaulted to 7 days';
            }
          }

          const delta = await s.getChangedSince(projEntry.id, cutoff);
          const brief = (e: Entry) => ({
            id: e.id,
            title: e.title,
            kind: e.metadata.kind ?? null,
            updatedAt: e.updatedAt,
          });
          return {
            content: [{
              type: 'text',
              text: formatToolResponse({
                project: roots.labels[0],
                since: cutoff,
                baseline,
                counts: {
                  created: delta.created.length,
                  updated: delta.updated.length,
                  deleted: delta.deleted.length,
                },
                created: delta.created.map(brief),
                updated: delta.updated.map(brief),
                deleted: delta.deleted.map(brief),
              }),
            }],
          };
        }
```

`resolveRoots`, `resolveActiveSessionId`, `findMarker`, and `formatToolResponse` all exist in server.ts already — match their exact signatures (read the tim_read section path at ~line 1675 for the `resolveRoots` return shape: `{ error?: string; labels?: string[] }`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/recall-tools.test.ts`
Expected: PASS. Then `npm test` — whole suite green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tim-mcp): tim_guard pre-action failure check + tim_delta session diff"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/tim-capabilities.md`, `CHANGELOG.md` `[Unreleased]`

- [ ] **Step 1: Document both tools**

Document: `tim_guard` (when to call it — before worker spawns, deploys, expensive/risky actions; what counts as negative memory — `kind ∈ {error, learning}` or `#error`/`#learning` tags), and `tim_delta` (default baseline = previous session's last activity, 7-day fallback, 500-row cap, explicitly a *supplement* to the full `tim_load_project` briefing — new sessions still need the full load because LLMs are stateless).

Also note the workflow hook opportunity for the user's o9k setup (do NOT edit files outside this repo): a pre-spawn hook can call `tim_guard` with the worker task description.

- [ ] **Step 2: Commit**

```bash
git add docs/tim-capabilities.md CHANGELOG.md
git commit -m "docs: tim_guard and tim_delta recall tools"
```
