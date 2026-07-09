# TIM Beta Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden TIM for beta by stabilizing tests, release gates, hmem migration safety, MCP guidance, and agent setup.

**Architecture:** Implement this in layers: first make the test/release gates deterministic, then add structured health and migration planning, then tighten risky command safety, then improve setup and MCP guidance. Keep each feature behind focused CLI/MCP surfaces and preserve current low-level tools.

**Tech Stack:** TypeScript, Vitest, NodeNext workspaces, better-sqlite3, MCP SDK, GitHub CLI/API, npm pack dry-run.

---

## Scope And Order

This plan covers items 1-10 from the beta-hardening discussion:

1. Decouple embedding tests from local model cache.
2. Configure branch protection and required CI.
3. Add `OK/WARN/BLOCKER` health severity.
4. Add a golden hmem-to-TIM E2E test.
5. Add `tim release-check`.
6. Add import-audit `repairPlan`.
7. Add snapshot/confirm safety for risky commands.
8. Harden MCP descriptions for agent order-of-operations.
9. Add `tim migrate-from-hmem` wizard.
10. Add `tim setup-agent`.

The first four tasks are beta blockers. Tasks 5-10 improve repeatability and onboarding.

---

### Task 1: Stabilize Embedding Tests

**Files:**
- Modify: `packages/tim-hooks/src/hooks.ts`
- Modify: `packages/tim-hooks/src/__tests__/embedding-hook.test.ts`

- [ ] **Step 1: Write a mocked embedding test**

Replace the first test in `packages/tim-hooks/src/__tests__/embedding-hook.test.ts` with a mock that does not need `local_cache/fast-all-MiniLM-L6-v2/model.onnx`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('fastembed', () => ({
  EmbeddingModel: { AllMiniLML6V2: 'fast-all-MiniLM-L6-v2' },
  FlagEmbedding: {
    init: vi.fn(async () => ({
      embed: async function* (texts: string[]) {
        yield texts.map(() => Array.from({ length: 384 }, (_, i) => i / 384));
      },
    })),
  },
}));
```

Keep the existing write/read assertion:

```ts
const count = await embedUnembeddedEntries(store, { batchSize: 5 });
expect(count).toBeGreaterThanOrEqual(1);
const unembedded = await store.getUnembedded(10);
expect(unembedded.find(u => u.id === e.id)).toBeUndefined();
```

- [ ] **Step 2: Add an optional real-model integration test**

Add a separate test guarded by `TIM_EMBEDDING_REAL_MODEL=1`:

```ts
it('embeds with the real local model when explicitly enabled', async () => {
  if (process.env.TIM_EMBEDDING_REAL_MODEL !== '1') return;
  vi.resetModules();
  const { embedUnembeddedEntries: realEmbed } = await import('../hooks.js');
  const e = await store.write('Real model test\nBody.', { tags: ['#embedding'] });
  const count = await realEmbed(store, { batchSize: 5 });
  expect(count).toBeGreaterThanOrEqual(1);
  const unembedded = await store.getUnembedded(10);
  expect(unembedded.find(u => u.id === e.id)).toBeUndefined();
});
```

- [ ] **Step 3: Run the focused test**

Run:

```bash
npm test --workspace tim-hooks -- --run src/__tests__/embedding-hook.test.ts
```

Expected: all embedding-hook tests pass without `model.onnx`.

- [ ] **Step 4: Run root tests**

Run:

```bash
npm test
```

Expected: root test suite no longer fails because of the missing ONNX file.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-hooks/src/hooks.ts packages/tim-hooks/src/__tests__/embedding-hook.test.ts
git commit -m "test: decouple embedding hook tests from local model cache"
```

---

### Task 2: Configure Branch Protection And Required CI

**Files:**
- Create: `docs/github-branch-protection.md`
- Modify: `.github/workflows/ci.yml` only if the workflow name or required job name is unclear.

- [ ] **Step 1: Capture current CI job names**

Run:

```bash
sed -n '1,220p' .github/workflows/ci.yml
gh repo view --json nameWithOwner,viewerPermission,visibility
```

Expected: repo is `Bumblebiber/tim`, viewer permission is `ADMIN`, workflow has stable job names.

- [ ] **Step 2: Write the protection doc**

Create `docs/github-branch-protection.md`:

~~~md
# GitHub Branch Protection

TIM beta uses `master` as the protected integration branch.

Rules:
- Require pull request before merging.
- Require status checks to pass before merging.
- Require the CI workflow job for build/tests.
- Block force pushes.
- Block deletions.
- Allow admins to bypass only for emergency release repair.

Recommended command:

```bash
gh api -X PUT repos/Bumblebiber/tim/branches/master/protection \
  -H "Accept: application/vnd.github+json" \
  --input docs/github-branch-protection.payload.json
```
~~~

- [ ] **Step 3: Add the exact API payload**

Create `docs/github-branch-protection.payload.json`:

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": true
}
```

If CI job is not named `ci`, replace `"ci"` with the exact required check from GitHub after first workflow run.

- [ ] **Step 4: Apply protection**

Run:

```bash
gh api -X PUT repos/Bumblebiber/tim/branches/master/protection \
  -H "Accept: application/vnd.github+json" \
  --input docs/github-branch-protection.payload.json
```

Expected: HTTP 200 response.

- [ ] **Step 5: Verify protection**

Run:

```bash
gh api repos/Bumblebiber/tim/branches/master/protection --jq '{required_status_checks,required_pull_request_reviews,allow_force_pushes,allow_deletions}'
```

Expected: required checks are present, force pushes and deletions disabled.

- [ ] **Step 6: Commit**

```bash
git add docs/github-branch-protection.md docs/github-branch-protection.payload.json .github/workflows/ci.yml
git commit -m "docs: document beta branch protection"
```

---

### Task 3: Add Health Severity To Doctor

**Files:**
- Modify: `packages/tim-core/src/types.ts`
- Modify: `packages/tim-store/src/store.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Modify: `packages/tim-mcp/src/server.ts`
- Add tests under `packages/tim-store/src/__tests__/health-severity.test.ts`
- Update generated `dist` for touched packages.

- [ ] **Step 1: Add the health type contract**

In `packages/tim-core/src/types.ts`, extend `HealthReport` with:

```ts
export type HealthSeverity = 'OK' | 'WARN' | 'BLOCKER';

export interface HealthReport {
  status: HealthSeverity;
  blockers: string[];
  warnings: string[];
  // existing fields remain unchanged
}
```

- [ ] **Step 2: Write failing store tests**

Create `packages/tim-store/src/__tests__/health-severity.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { TimStore } from '../store.js';

let store: TimStore | null = null;
afterEach(() => { store?.close(); store = null; });

describe('health severity', () => {
  it('returns OK for a fresh database', async () => {
    store = new TimStore(':memory:');
    const health = await store.health();
    expect(health.status).toBe('OK');
    expect(health.blockers).toEqual([]);
    expect(health.warnings).toEqual([]);
  });

  it('returns WARN for broken links or orphans', async () => {
    store = new TimStore(':memory:');
    const parent = await store.write('Parent');
    const child = await store.write('Child', { parentId: parent.id });
    store.getDb().prepare('UPDATE entries SET parent_id = ? WHERE id = ?').run('missing-parent', child.id);
    const health = await store.health();
    expect(health.status).toBe('WARN');
    expect(health.warnings.join('\\n')).toMatch(/orphan/i);
  });
});
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
npm test --workspace tim-store -- --run src/__tests__/health-severity.test.ts
```

Expected: fails because `status`, `blockers`, and `warnings` are missing.

- [ ] **Step 4: Implement severity mapping**

In `TimStore.health()`, keep existing `issues`, then add:

```ts
const blockers: string[] = [];
const warnings: string[] = [];

if (!ftsOk) blockers.push('FTS5 index integrity failure');
if (brokenLinks.count > 0) warnings.push(`${brokenLinks.count} broken links`);
if (orphans.count > 0) warnings.push(`${orphans.count} orphan entries`);
if (stale.count > 0) warnings.push(`${stale.count} stale entries (older than ${threshold}d, unverified)`);

const status = blockers.length > 0 ? 'BLOCKER' : warnings.length > 0 ? 'WARN' : 'OK';
```

Return the three new fields in the health report.

- [ ] **Step 5: Surface severity in CLI/MCP**

In `cmdDoctor()`, print:

```ts
console.log(`Status: ${health.status}`);
```

In `tim_doctor`, include:

```ts
`Status: ${report.status}`,
report.blockers.length ? `BLOCKERS: ${report.blockers.join('; ')}` : null,
report.warnings.length ? `WARNINGS: ${report.warnings.join('; ')}` : null,
```

- [ ] **Step 6: Verify**

Run:

```bash
npm test --workspace tim-store -- --run src/__tests__/health-severity.test.ts
npm test --workspace tim-mcp -- --run src/__tests__/stats-output.test.ts src/__tests__/schema-drift.test.ts
npm run build
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/tim-core packages/tim-store packages/tim-cli packages/tim-mcp
git add -f packages/*/dist
git commit -m "feat: add health severity to doctor"
```

---

### Task 4: Add Golden hmem-to-TIM E2E

**Files:**
- Create: `packages/tim-mcp/src/__tests__/hmem-golden-e2e.test.ts`
- Reuse: `packages/tim-mcp/src/__tests__/import-audit-tools.test.ts`

- [ ] **Step 1: Write the golden fixture test**

Create `packages/tim-mcp/src/__tests__/hmem-golden-e2e.test.ts` by copying the `McpClient` helper from `import-audit-tools.test.ts`. Add a fixture with one project, canonical sections, nested nodes, and one link.

Test flow:

```ts
it('migrates, audits, repairs, and loads a hmem project', async () => {
  const manifest = parsePayload(await client.callTool('tim_import_manifest', { source: hmemPath }));
  expect(manifest.labels.map((l: any) => l.label)).toContain('P0100');

  const dry = parsePayload(await client.callTool('tim_import', {
    source: hmemPath,
    dryRun: true,
    deduplicate: true,
  }));
  expect(dry.dryRun).toBe(true);
  expect(dry.newCount).toBeGreaterThan(0);

  const imported = parsePayload(await client.callTool('tim_import', {
    source: hmemPath,
    deduplicate: true,
  }));
  expect(imported.entriesImported).toBeGreaterThan(0);

  const audit = parsePayload(await client.callTool('tim_import_audit', { source: hmemPath }));
  expect(audit.projects[0].label).toBe('P0100');

  const repair = parsePayload(await client.callTool('tim_repair_section', {
    project: 'P0100',
    title: 'Tasks',
  }));
  expect(repair.section.id).toBeTruthy();

  const loaded = parsePayload(await client.callTool('tim_load_project', {
    label: 'P0100',
    bind: false,
    depth: 3,
  }));
  expect(JSON.stringify(loaded)).toContain('P0100');
});
```

- [ ] **Step 2: Run the failing test if any tool behavior is missing**

Run:

```bash
npm test --workspace tim-mcp -- --run src/__tests__/hmem-golden-e2e.test.ts
```

Expected: pass if current import-audit tools are sufficient; otherwise fail with the missing behavior.

- [ ] **Step 3: Fix only missing golden-flow behavior**

If the test fails, update `packages/tim-mcp/src/server.ts` or `packages/tim-migrate/src/import.ts` only for behavior exercised by the test. Do not add new automation beyond the golden path.

- [ ] **Step 4: Verify**

Run:

```bash
npm test --workspace tim-mcp -- --run src/__tests__/hmem-golden-e2e.test.ts src/__tests__/import-audit-tools.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add packages/tim-mcp/src/__tests__/hmem-golden-e2e.test.ts packages/tim-mcp/src/server.ts packages/tim-migrate/src/import.ts
git add -f packages/tim-mcp/dist packages/tim-migrate/dist
git commit -m "test: add golden hmem migration e2e"
```

---

### Task 5: Add `tim release-check`

**Files:**
- Create: `packages/tim-cli/src/release-check.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Create: `packages/tim-cli/src/__tests__/release-check.test.ts`
- Modify: `docs/tim-cli-reference.md`
- Add sample under `docs/tim-cli-reference-samples/`

- [ ] **Step 1: Write unit tests**

Create `packages/tim-cli/src/__tests__/release-check.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildReleaseCheckPlan, summarizeReleaseCheck } from '../release-check.js';

describe('release-check', () => {
  it('includes beta gates in deterministic order', () => {
    const plan = buildReleaseCheckPlan({ beta: true });
    expect(plan.map(step => step.id)).toEqual([
      'git-clean',
      'build',
      'tests',
      'pack',
      'cli-smoke',
      'mcp-smoke',
      'large-files',
    ]);
  });

  it('summarizes blockers when a gate fails', () => {
    const summary = summarizeReleaseCheck([
      { id: 'build', ok: true, detail: 'ok' },
      { id: 'tests', ok: false, detail: '1 failure' },
    ]);
    expect(summary.status).toBe('BLOCKER');
    expect(summary.blockers).toEqual(['tests: 1 failure']);
  });
});
```

- [ ] **Step 2: Run tests red**

Run:

```bash
npm test --workspace tim-cli -- --run src/__tests__/release-check.test.ts
```

Expected: fails because `release-check.ts` does not exist.

- [ ] **Step 3: Implement pure planner and summary**

Create `packages/tim-cli/src/release-check.ts`:

```ts
export interface ReleaseCheckStep {
  id: string;
  command?: string;
}

export interface ReleaseCheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export function buildReleaseCheckPlan(_: { beta?: boolean } = {}): ReleaseCheckStep[] {
  return [
    { id: 'git-clean', command: 'git status --short --branch' },
    { id: 'build', command: 'npm run build' },
    { id: 'tests', command: 'npm test' },
    { id: 'pack', command: 'npm pack --dry-run --workspaces' },
    { id: 'cli-smoke', command: 'tim --help && tim doctor' },
    { id: 'mcp-smoke', command: 'tim-mcp smoke via tim_doctor' },
    { id: 'large-files', command: 'git ls-files -s' },
  ];
}

export function summarizeReleaseCheck(results: ReleaseCheckResult[]) {
  const blockers = results.filter(r => !r.ok).map(r => `${r.id}: ${r.detail}`);
  return { status: blockers.length ? 'BLOCKER' : 'OK', blockers, results };
}
```

- [ ] **Step 4: Wire CLI command**

In `printCommandHelp`, add:

```ts
case 'release-check':
  console.log(`Usage: tim release-check [--beta] [--json]`);
  return;
```

In the command switch, add `case 'release-check': await cmdReleaseCheck(args.slice(1)); return;`.

Implement `cmdReleaseCheck()` to run commands with `child_process.execFileSync` for `build`, `pack`, and optional smoke checks. Keep `npm test` configurable:

```ts
const skipTests = flags['skip-tests'] === 'true';
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test --workspace tim-cli -- --run src/__tests__/release-check.test.ts src/__tests__/help-safety.test.ts
npm run build
node packages/tim-cli/dist/cli.js release-check --beta --json
```

Expected: JSON summary with `status`.

- [ ] **Step 6: Commit**

```bash
git add packages/tim-cli docs/tim-cli-reference.md docs/tim-cli-reference-samples
git add -f packages/tim-cli/dist
git commit -m "feat: add TIM release-check command"
```

---

### Task 6: Add Import-Audit Repair Plan

**Files:**
- Modify: `packages/tim-mcp/src/server.ts`
- Modify: `packages/tim-mcp/src/__tests__/import-audit-tools.test.ts`
- Update generated `packages/tim-mcp/dist`

- [ ] **Step 1: Extend test expectations**

In `import-audit-tools.test.ts`, add:

```ts
const audit = parsePayload(await client.callTool('tim_import_audit', {
  source: hmemPath,
  includeRepairPlan: true,
}));
expect(audit.repairPlan.actions.some((a: any) => a.tool === 'tim_repair_section')).toBe(true);
expect(audit.repairPlan.applyAutomatically).toBe(false);
```

- [ ] **Step 2: Extend schema**

In `TimImportAuditSchema`, add:

```ts
includeRepairPlan: z.boolean().optional().default(false)
  .describe('If true, include suggested tool calls. Does not execute them.'),
```

- [ ] **Step 3: Build repair actions**

Inside `tim_import_audit`, create:

```ts
const repairActions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [];
```

For each missing section:

```ts
repairActions.push({
  tool: 'tim_repair_section',
  args: { project: label, title },
  reason: `${label}: create missing section ${title}`,
});
```

For each loose direct child:

```ts
repairActions.push({
  tool: 'tim_dry_run_move',
  args: { id: loose.id, newParentId: '<choose-section-id>' },
  reason: `${label}: loose child requires human section choice`,
});
```

Return:

```ts
repairPlan: includeRepairPlan ? {
  applyAutomatically: false,
  actions: repairActions,
} : undefined
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test --workspace tim-mcp -- --run src/__tests__/import-audit-tools.test.ts src/__tests__/schema-drift.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/import-audit-tools.test.ts
git add -f packages/tim-mcp/dist
git commit -m "feat: add repair plans to import audit"
```

---

### Task 7: Add Snapshot And Confirm Safety For Risky Commands

**Files:**
- Create: `packages/tim-cli/src/safety.ts`
- Create: `packages/tim-cli/src/__tests__/safety.test.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Modify: `packages/tim-cli/src/restore.ts`

- [ ] **Step 1: Write safety helper tests**

Create `packages/tim-cli/src/__tests__/safety.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { requiresSnapshot, requiresConfirm } from '../safety.js';

describe('risk safety', () => {
  it('requires snapshot for live imports and repairs', () => {
    expect(requiresSnapshot('import', { dryRun: false })).toBe(true);
    expect(requiresSnapshot('import', { dryRun: true })).toBe(false);
    expect(requiresSnapshot('repair-flags', { dryRun: false })).toBe(true);
  });

  it('requires confirm for destructive commands', () => {
    expect(requiresConfirm('restore', { force: true })).toBe(true);
    expect(requiresConfirm('delete-batch', { hard: true })).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests red**

```bash
npm test --workspace tim-cli -- --run src/__tests__/safety.test.ts
```

- [ ] **Step 3: Implement helper**

Create `packages/tim-cli/src/safety.ts`:

```ts
export function requiresSnapshot(command: string, flags: Record<string, unknown>): boolean {
  if (flags.dryRun === true || flags['dry-run'] === 'true') return false;
  return ['import', 'repair-flags', 'migrate-from-hmem'].includes(command);
}

export function requiresConfirm(command: string, flags: Record<string, unknown>): boolean {
  if (command === 'restore' && flags.force === true) return true;
  if (command === 'delete-batch' && flags.hard === true) return true;
  return false;
}
```

- [ ] **Step 4: Wire import snapshot warning**

In `cmdImport()`, before live import:

```ts
if (requiresSnapshot(flags['repair-flags'] === 'true' ? 'repair-flags' : 'import', flags) &&
    flags['no-snapshot-check'] !== 'true') {
  console.error('Refusing live import without snapshot acknowledgement. Run `tim snapshot` first or pass --no-snapshot-check.');
  process.exit(1);
}
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test --workspace tim-cli -- --run src/__tests__/safety.test.ts src/__tests__/help-safety.test.ts
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add packages/tim-cli/src/safety.ts packages/tim-cli/src/__tests__/safety.test.ts packages/tim-cli/src/cli.ts packages/tim-cli/src/restore.ts
git add -f packages/tim-cli/dist
git commit -m "feat: add safety gates for risky CLI commands"
```

---

### Task 8: Harden MCP Tool Descriptions

**Files:**
- Modify: `packages/tim-mcp/src/server.ts`
- Modify: `packages/tim-mcp/src/__tests__/schema-drift.test.ts`
- Add: `packages/tim-mcp/src/__tests__/tool-guidance.test.ts`

- [ ] **Step 1: Add guidance tests**

Create `packages/tim-mcp/src/__tests__/tool-guidance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_DEFS } from '../server.js';

function desc(name: string): string {
  return TOOL_DEFS.find(d => d.name === name)?.description ?? '';
}

describe('MCP tool guidance', () => {
  it('guides hmem import order', () => {
    expect(desc('tim_import')).toContain('dryRun:true');
    expect(desc('tim_import')).toContain('tim_import_manifest');
    expect(desc('tim_import')).toContain('tim_import_audit');
  });

  it('warns write tools to read before replacing content', () => {
    expect(desc('tim_update')).toContain('tim_read first');
    expect(desc('tim_move_entry')).toContain('Preview with tim_dry_run_move');
  });
});
```

- [ ] **Step 2: Run tests red**

```bash
npm test --workspace tim-mcp -- --run src/__tests__/tool-guidance.test.ts
```

- [ ] **Step 3: Update descriptions**

Change `tim_import` description to:

```ts
description: 'Import entries from a .hmem SQLite file. Always call tim_import_manifest first, then tim_import with dryRun:true, then live import, then tim_import_audit. Never use raw SQL for hmem migration.',
```

Change `tim_move_entry` description to:

```ts
description: 'Move an entry under a new parent and cascade depth updates to descendants. Preview with tim_dry_run_move before moving imported or ambiguous nodes.',
```

- [ ] **Step 4: Verify**

```bash
npm test --workspace tim-mcp -- --run src/__tests__/tool-guidance.test.ts src/__tests__/schema-drift.test.ts
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/tool-guidance.test.ts
git add -f packages/tim-mcp/dist
git commit -m "docs: harden MCP tool guidance for agents"
```

---

### Task 9: Add `tim migrate-from-hmem` Wizard

**Files:**
- Create: `packages/tim-cli/src/migrate-from-hmem.ts`
- Create: `packages/tim-cli/src/__tests__/migrate-from-hmem.test.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Modify: `docs/hmem-to-tim-migration.md`
- Modify: `docs/tim-cli-reference.md`

- [ ] **Step 1: Write planner tests**

Create `packages/tim-cli/src/__tests__/migrate-from-hmem.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMigrateFromHmemPlan } from '../migrate-from-hmem.js';

describe('migrate-from-hmem planner', () => {
  it('runs manifest, dry-run, snapshot, import, audit, doctor in order', () => {
    const plan = buildMigrateFromHmemPlan('/tmp/source.hmem', { deduplicate: true });
    expect(plan.map(s => s.id)).toEqual([
      'manifest',
      'dry-run',
      'snapshot',
      'import',
      'audit',
      'doctor',
      'handoff',
    ]);
  });
});
```

- [ ] **Step 2: Run tests red**

```bash
npm test --workspace tim-cli -- --run src/__tests__/migrate-from-hmem.test.ts
```

- [ ] **Step 3: Implement the wizard planner**

Create `packages/tim-cli/src/migrate-from-hmem.ts`:

```ts
export interface HmemWizardStep {
  id: string;
  description: string;
}

export function buildMigrateFromHmemPlan(source: string, opts: { deduplicate?: boolean } = {}): HmemWizardStep[] {
  return [
    { id: 'manifest', description: `Inspect ${source}` },
    { id: 'dry-run', description: `Import dry-run with deduplicate=${opts.deduplicate !== false}` },
    { id: 'snapshot', description: 'Create TIM snapshot before writing' },
    { id: 'import', description: 'Run live import' },
    { id: 'audit', description: 'Run import audit and print repair suggestions' },
    { id: 'doctor', description: 'Run TIM doctor' },
    { id: 'handoff', description: 'Print source, snapshot, counts, warnings, next steps' },
  ];
}
```

- [ ] **Step 4: Implement command execution**

`cmdMigrateFromHmem(args)` should:

1. Validate source exists.
2. Print manifest via `inspectHmemManifest`.
3. Run `tim_import(..., { dryRun:true, deduplicate:true })`.
4. Run `runSnapshot()`.
5. Run live `tim_import`.
6. Print a message telling users to run MCP `tim_import_audit` if MCP is available.
7. Run `store.health()`.
8. Print JSON handoff.

- [ ] **Step 5: Wire CLI**

Add help:

```ts
case 'migrate-from-hmem':
  console.log(`Usage: tim migrate-from-hmem <path.hmem> [--deduplicate] [--dry-run]`);
  return;
```

Add switch case:

```ts
case 'migrate-from-hmem':
  await cmdMigrateFromHmem(args.slice(1));
  return;
```

- [ ] **Step 6: Verify**

```bash
npm test --workspace tim-cli -- --run src/__tests__/migrate-from-hmem.test.ts src/__tests__/help-safety.test.ts
npm test --workspace tim-migrate -- --run
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add packages/tim-cli/src/migrate-from-hmem.ts packages/tim-cli/src/__tests__/migrate-from-hmem.test.ts packages/tim-cli/src/cli.ts docs/hmem-to-tim-migration.md docs/tim-cli-reference.md
git add -f packages/tim-cli/dist
git commit -m "feat: add hmem migration wizard"
```

---

### Task 10: Add `tim setup-agent`

**Files:**
- Create: `packages/tim-cli/src/setup-agent.ts`
- Create: `packages/tim-cli/src/__tests__/setup-agent.test.ts`
- Modify: `packages/tim-cli/src/cli.ts`
- Reuse: `packages/tim-cli/src/update-skills.ts`
- Reuse: `packages/tim-cli/src/install.ts`
- Modify: `docs/tim-cli-reference.md`

- [ ] **Step 1: Write planner tests**

Create `packages/tim-cli/src/__tests__/setup-agent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSetupAgentPlan } from '../setup-agent.js';

describe('setup-agent planner', () => {
  it('plans MCP, skills, hooks, and smoke for claude', () => {
    const plan = buildSetupAgentPlan({ host: 'claude' });
    expect(plan.map(s => s.id)).toEqual(['mcp', 'skills', 'hooks', 'smoke']);
  });

  it('supports known hosts', () => {
    expect(() => buildSetupAgentPlan({ host: 'codex' })).not.toThrow();
    expect(() => buildSetupAgentPlan({ host: 'cursor' })).not.toThrow();
    expect(() => buildSetupAgentPlan({ host: 'hermes' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests red**

```bash
npm test --workspace tim-cli -- --run src/__tests__/setup-agent.test.ts
```

- [ ] **Step 3: Implement planner**

Create `packages/tim-cli/src/setup-agent.ts`:

```ts
export type AgentHost = 'claude' | 'codex' | 'cursor' | 'hermes';

export function buildSetupAgentPlan(opts: { host: AgentHost }) {
  return [
    { id: 'mcp', description: `Install MCP config for ${opts.host}` },
    { id: 'skills', description: `Install TIM skills for ${opts.host}` },
    { id: 'hooks', description: `Install supported hooks/statusline for ${opts.host}` },
    { id: 'smoke', description: 'Run tim doctor and MCP smoke guidance' },
  ];
}
```

- [ ] **Step 4: Implement command execution**

`cmdSetupAgent(args)` should:

1. Parse `--host`.
2. Call `installMcpForHosts(dbPath, true)`.
3. Call `updateSkills()`.
4. For `hermes`, call `cmdSetupHermesStatusline(['--skip-build'])`.
5. Run `tim doctor` equivalent via store health.
6. Print JSON result with installed/skipped/smoke status.

- [ ] **Step 5: Wire CLI**

Help:

```ts
case 'setup-agent':
  console.log(`Usage: tim setup-agent --host claude|codex|cursor|hermes [--dry-run]`);
  return;
```

Switch:

```ts
case 'setup-agent':
  await cmdSetupAgent(args.slice(1));
  return;
```

- [ ] **Step 6: Verify**

```bash
npm test --workspace tim-cli -- --run src/__tests__/setup-agent.test.ts src/__tests__/install.test.ts src/__tests__/help-safety.test.ts
npm run build
node packages/tim-cli/dist/cli.js setup-agent --host codex --dry-run
```

- [ ] **Step 7: Commit**

```bash
git add packages/tim-cli/src/setup-agent.ts packages/tim-cli/src/__tests__/setup-agent.test.ts packages/tim-cli/src/cli.ts docs/tim-cli-reference.md
git add -f packages/tim-cli/dist
git commit -m "feat: add agent setup command"
```

---

## Final Verification

After all tasks:

```bash
git status --short --branch
npm run build
npm test
npm pack --dry-run --workspaces
node packages/tim-cli/dist/cli.js release-check --beta --json
```

Known acceptable temporary blocker: if `npm test` fails only because a real embedding model is unavailable, Task 1 is incomplete and must be fixed before beta.

## Completion Criteria

- Root tests pass without local model cache.
- `master` branch protection is configured and documented.
- `tim doctor` and `tim_doctor` expose machine-readable severity.
- hmem migration has golden E2E coverage.
- `tim release-check --beta` exists.
- `tim_import_audit` can emit a non-executing repair plan.
- Risky CLI commands require snapshot acknowledgement or explicit override.
- MCP descriptions encode correct agent order-of-operations.
- `tim migrate-from-hmem` guides hmem users through safe migration.
- `tim setup-agent` reduces host onboarding to one command plus smoke output.
