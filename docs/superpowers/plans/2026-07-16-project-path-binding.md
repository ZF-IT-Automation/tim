# Project Path Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every project creation explicitly filesystem-bound or memory-only, with CLI and MCP sharing one coordinated database/marker service, then recover `/home/bbbee/projects/o9k` in the configured live TIM database.

**Architecture:** `tim-hooks` will own a coordinated project-creation service because it can depend on `tim-store` and already owns marker I/O. A new no-clobber marker publisher will use a same-directory temporary file plus `linkSync`, while the service performs validation/preflight, commits the database entry, publishes and verifies the marker, and reports partial state precisely. MCP and CLI remain presentation/transport layers; `TimStore.createProject` remains the low-level database primitive.

**Tech Stack:** TypeScript 5.9, Node.js 24 ESM filesystem APIs, SQLite through `TimStore`, Zod 3, MCP SDK, Vitest 3, npm workspaces, committed TypeScript `dist` artifacts.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `packages/tim-hooks/src/marker.ts` | Add exclusive, atomic, no-clobber marker publication and its typed conflict error. |
| `packages/tim-hooks/src/project-creation.ts` | New shared validation, coordinated project creation, safe recovery binding, canonical-path and shell-quote logic. |
| `packages/tim-hooks/src/index.ts` | Export the shared service, result types, errors, and exclusive marker writer. |
| `packages/tim-hooks/src/__tests__/marker.test.ts` | Prove exclusive publication never overwrites a winner and cleans temporary files. |
| `packages/tim-hooks/src/__tests__/project-creation.test.ts` | Exhaustively test mode/path validation, canonicalization, conflicts, races, phase failures, response shape, and recovery. |
| `packages/tim-mcp/src/server.ts` | Expose the exclusive schema/description and delegate `tim_create_project` to the shared service for HTTP and stdio. |
| `packages/tim-mcp/src/__tests__/create-project-contract.test.ts` | End-to-end stdio MCP contract for invalid, memory-only, and bound calls. |
| Eleven existing `packages/tim-mcp/src/__tests__/*.test.ts` files listed in Task 6 | Explicitly mark intentionally database-only fixtures with `memoryOnly: true`. |
| `packages/tim-cli/src/new-project.ts` | Keep CLI directory creation, confirmation, section setup and git setup; delegate database plus marker creation and retry labels to the service. |
| `packages/tim-cli/src/cli.ts` | Make `bind-project` a database-validated, no-clobber, idempotent recovery operation. |
| `packages/tim-cli/src/__tests__/new-project.test.ts` | Prove CLI behavior survives delegation, including label-race retry and identical marker conflicts. |
| `packages/tim-cli/src/__tests__/resolve-project.test.ts` | Test safe `bind-project` recovery instead of marker overwriting. |
| `packages/tim-skills/skills/tim-new-project/SKILL.md` | Canonical production agent workflow requiring `path` for codebases and `memoryOnly` only for virtual projects. |
| `packages/tim-skills/src/tim-new-project.ts` | Export the same guidance through the `tim-skills` runtime API. |
| `packages/tim-skills/src/index.ts` | Register and export the new skill. |
| `packages/tim-skills/src/__tests__/skills.test.ts` | Guard the installed project-creation guidance. |
| `docs/tim-cli-reference.md` | Document the coordinated (not transactional) operation and safe recovery command. |
| `packages/*/dist/**` | Rebuilt, committed package outputs required by this repository. |

### Task 1: Add the exclusive marker publisher

**Files:**
- Modify: `packages/tim-hooks/src/marker.ts:245` (`writeMarkerAtomic` / `writeMarker`)
- Modify: `packages/tim-hooks/src/index.ts:28` (marker exports)
- Test: `packages/tim-hooks/src/__tests__/marker.test.ts:384` (marker write tests)

- [ ] **Step 1: Write failing no-clobber tests**

Add these imports and tests to `marker.test.ts`:

```ts
import {
  ExclusiveMarkerConflictError,
  markerPath,
  readMarker,
  writeMarkerExclusive,
} from '../marker.js';

it('writeMarkerExclusive publishes a complete v2 marker without temp residue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-marker-exclusive-'));
  const marker = writeMarkerExclusive(dir, {
    project: 'P0042', session: 'fresh', exchanges: 0, batch_size: 5, batches_summarized: 0,
  });
  expect(marker).toMatchObject({ version: 2, project: 'P0042', session: 'fresh' });
  expect(readMarker(dir)).toEqual(marker);
  expect(fs.readdirSync(dir).filter(name => name.includes('.tmp.'))).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

it('writeMarkerExclusive never overwrites a marker published by a racing writer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-marker-race-'));
  const winner = JSON.stringify({
    version: 2, project: 'P0043', session: 'winner', exchanges: 0,
    batch_size: 5, batches_summarized: 0,
  }, null, 2);
  fs.writeFileSync(markerPath(dir), winner, { flag: 'wx' });
  expect(() => writeMarkerExclusive(dir, {
    project: 'P0042', session: 'loser', exchanges: 0, batch_size: 5, batches_summarized: 0,
  })).toThrow(ExclusiveMarkerConflictError);
  expect(fs.readFileSync(markerPath(dir), 'utf8')).toBe(winner);
  expect(fs.readdirSync(dir).filter(name => name.includes('.tmp.'))).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the focused test and observe red**

Run: `npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts`

Expected: FAIL because `ExclusiveMarkerConflictError` and `writeMarkerExclusive` are not exported.

- [ ] **Step 3: Implement the no-clobber publisher**

Add to `marker.ts` immediately after `writeMarkerAtomic`:

```ts
export class ExclusiveMarkerConflictError extends Error {
  constructor(public readonly filePath: string) {
    super(`Local marker already exists: ${filePath}`);
    this.name = 'ExclusiveMarkerConflictError';
  }
}

export function writeMarkerExclusive(
  cwd: string,
  marker: ProjectMarkerInput,
): ProjectMarker {
  if (!validateProjectLabel(marker.project)) {
    throw new Error(`Invalid project label for marker: ${marker.project}`);
  }
  const filePath = markerPath(cwd);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const complete: ProjectMarker = { ...marker, version: MARKER_VERSION };
  try {
    fs.writeFileSync(tmp, JSON.stringify(complete, null, 2), { flag: 'wx' });
    try {
      fs.linkSync(tmp, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ExclusiveMarkerConflictError(filePath);
      }
      throw error;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return complete;
}
```

Also add `import * as crypto from 'node:crypto';` and export both symbols from `index.ts`.

- [ ] **Step 4: Run the focused test and observe green**

Run: `npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts`

Expected: PASS; the existing rename-based writer tests remain green.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-hooks/src/marker.ts packages/tim-hooks/src/index.ts packages/tim-hooks/src/__tests__/marker.test.ts
git commit -m "feat(tim-hooks): publish project markers without clobbering"
```

### Task 2: Build and validate the shared creation service

**Files:**
- Create: `packages/tim-hooks/src/project-creation.ts`
- Create: `packages/tim-hooks/src/__tests__/project-creation.test.ts`
- Modify: `packages/tim-hooks/src/index.ts:28`

- [ ] **Step 1: Write failing validation and memory-only tests**

Create `project-creation.test.ts` with a fresh temp directory/database per test and these cases:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { createProjectCoordinated } from '../project-creation.js';

describe('createProjectCoordinated validation', () => {
  let root: string;
  let store: TimStore;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-project-create-'));
    store = new TimStore(path.join(root, 'test.db'));
  });
  afterEach(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const assertNoProject = async () => expect(await store.listProjects()).toHaveLength(0);

  it.each([
    [{ label: 'P0100' }, /Pass an absolute project path.*memoryOnly: true/i],
    [{ label: 'P0100', path: root, memoryOnly: true }, /exactly one creation mode/i],
    [{ label: 'P0100', memoryOnly: false }, /memoryOnly: true/i],
    [{ label: 'P0100', path: 'relative/repo' }, /absolute project path/i],
    [{ label: 'P0100', path: '~/repo' }, /shorthand/i],
    [{ label: 'P0100', path: '$HOME/repo' }, /shorthand/i],
  ])('rejects invalid mode/path before writes: %j', async (args, message) => {
    await expect(createProjectCoordinated(store, args)).rejects.toThrow(message);
    await assertNoProject();
  });

  it('rejects home and non-directories before writes', async () => {
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'x');
    await expect(createProjectCoordinated(store, { label: 'P0100', path: os.homedir() }))
      .rejects.toThrow(/home directory/i);
    await expect(createProjectCoordinated(store, { label: 'P0100', path: file }))
      .rejects.toThrow(/directory/i);
    await assertNoProject();
  });

  it('rejects metadata.path for memory-only creation', async () => {
    await expect(createProjectCoordinated(store, {
      label: 'P0100', memoryOnly: true, metadata: { path: '/tmp/fake' },
    })).rejects.toThrow(/metadata\.path.*service-owned/i);
    await assertNoProject();
  });

  it('creates an intentional memory-only project without marker fields', async () => {
    const result = await createProjectCoordinated(store, {
      label: 'P0100', memoryOnly: true, content: 'Virtual', aliases: ['virtual'],
    });
    expect(result).toMatchObject({ mode: 'memory-only', metadata: { label: 'P0100' } });
    expect('projectPath' in result).toBe(false);
    expect('markerPath' in result).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and observe red**

Run: `npx vitest run packages/tim-hooks/src/__tests__/project-creation.test.ts`

Expected: FAIL because `project-creation.js` does not exist.

- [ ] **Step 3: Implement the types, mode validation, canonical path validation, preflight, and memory-only branch**

Create `project-creation.ts` with these public contracts and helpers; Task 2's minimal red/green slice implements validation and memory-only creation, while Task 3 replaces the final bound-mode guard with marker orchestration:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';
import { markerPath, readMarker, writeMarkerExclusive, type ProjectMarker } from './marker.js';

export interface ProjectCreationArgs {
  label: string;
  content?: string;
  metadata?: Record<string, unknown>;
  aliases?: string[];
  path?: string;
  memoryOnly?: boolean;
}

export type MemoryOnlyProjectCreationResult = Entry & { mode: 'memory-only' };
export type BoundProjectCreationResult = Entry & {
  mode: 'bound'; projectPath: string; markerPath: string;
};
export type ProjectCreationResult =
  | MemoryOnlyProjectCreationResult
  | BoundProjectCreationResult;

export interface ProjectCreationDeps {
  sessionId: () => string;
  writeExclusive: typeof writeMarkerExclusive;
  preflight: (projectPath: string) => void;
}

const DEFAULT_DEPS: ProjectCreationDeps = {
  sessionId: () => crypto.randomUUID(),
  writeExclusive: writeMarkerExclusive,
  preflight: preflightWritable,
};

export const MODE_ERROR =
  'Exactly one creation mode is required. Pass an absolute project path for a repository/workspace, or memoryOnly: true only when no directory should be bound.';

function validateMode(args: ProjectCreationArgs): 'bound' | 'memory-only' {
  const hasPath = typeof args.path === 'string' && args.path.length > 0;
  const isMemoryOnly = args.memoryOnly === true;
  if (hasPath === isMemoryOnly || (args.memoryOnly === false && !hasPath)) throw new Error(MODE_ERROR);
  if (isMemoryOnly && Object.hasOwn(args.metadata ?? {}, 'path')) {
    throw new Error('metadata.path is service-owned; memory-only creation cannot supply it.');
  }
  return hasPath ? 'bound' : 'memory-only';
}

function canonicalDirectory(rawPath: string): string {
  if (rawPath.startsWith('~') || /\$(?:\{|[A-Za-z_])|%[A-Za-z_][A-Za-z0-9_]*%/.test(rawPath)) {
    throw new Error(`Project path must not use ~ or environment-variable shorthand: ${rawPath}`);
  }
  if (!path.isAbsolute(rawPath)) throw new Error(`Pass an absolute project path: ${rawPath}`);
  const canonical = fs.realpathSync.native(rawPath);
  if (canonical === fs.realpathSync.native(os.homedir())) {
    throw new Error(`Refusing to bind the home directory: ${canonical}`);
  }
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`Project path is not a directory: ${canonical}`);
  return canonical;
}

function preflightWritable(projectPath: string): void {
  const probe = path.join(projectPath, `.tim-project.preflight.${process.pid}.${crypto.randomUUID()}`);
  try { fs.writeFileSync(probe, '', { flag: 'wx' }); }
  finally { fs.rmSync(probe, { force: true }); }
}

export async function createProjectCoordinated(
  store: TimStore,
  args: ProjectCreationArgs,
  deps: Partial<ProjectCreationDeps> = {},
): Promise<ProjectCreationResult> {
  const runtime = { ...DEFAULT_DEPS, ...deps };
  const mode = validateMode(args);
  if (mode === 'memory-only') {
    const entry = await store.createProject(args.label, {
      content: args.content, metadata: args.metadata, aliases: args.aliases,
    });
    return { ...entry, mode };
  }
  const projectPath = canonicalDirectory(args.path!);
  if (fs.existsSync(markerPath(projectPath))) throw new Error(`Path already has a local .tim-project: ${projectPath}`);
  runtime.preflight(projectPath);
  throw new Error(`Bound project creation requires verified marker publication at ${projectPath}`);
}
```

Export all public types/functions from `index.ts`.

- [ ] **Step 4: Run validation tests and observe green**

Run: `npx vitest run packages/tim-hooks/src/__tests__/project-creation.test.ts -t 'validation'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-hooks/src/project-creation.ts packages/tim-hooks/src/index.ts packages/tim-hooks/src/__tests__/project-creation.test.ts
git commit -m "feat(tim-hooks): validate explicit project creation modes"
```

### Task 3: Complete coordinated bound creation and safe recovery

**Files:**
- Modify: `packages/tim-hooks/src/project-creation.ts`
- Modify: `packages/tim-hooks/src/__tests__/project-creation.test.ts`

- [ ] **Step 1: Add failing bound-flow, race, failure-phase, and recovery tests**

Add tests using `fs.symlinkSync(real, link, 'dir')` and dependency injection:

```ts
it('canonicalizes a symlink, owns metadata.path, ignores an ancestor marker, and verifies v2 output', async () => {
  const real = path.join(root, 'real'); const link = path.join(root, 'link');
  fs.mkdirSync(real); fs.symlinkSync(real, link, 'dir');
  fs.writeFileSync(path.join(root, '.tim-project'), JSON.stringify({
    version: 2, project: 'P0999', session: 'ancestor', exchanges: 0,
    batch_size: 5, batches_summarized: 0,
  }));
  const result = await createProjectCoordinated(store, {
    label: 'P0101', path: link, content: 'Bound', metadata: { path: '/ignored', name: 'Bound' },
  }, { sessionId: () => 'fresh-session', writeExclusive: writeMarkerExclusive });
  expect(result).toMatchObject({
    mode: 'bound', projectPath: real, markerPath: path.join(real, '.tim-project'),
    metadata: { path: real, name: 'Bound' },
  });
  expect(readMarker(real)).toMatchObject({
    version: 2, project: 'P0101', session: 'fresh-session', exchanges: 0,
    batch_size: 5, batches_summarized: 0,
  });
});

it('does not mutate DB or an existing local marker', async () => {
  const target = path.join(root, 'target'); fs.mkdirSync(target);
  const winner = '{"project":"P0102"}';
  fs.writeFileSync(path.join(target, '.tim-project'), winner);
  await expect(createProjectCoordinated(store, { label: 'P0101', path: target }))
    .rejects.toThrow(/remove.*rebind|rebind.*remove/i);
  expect(fs.readFileSync(path.join(target, '.tim-project'), 'utf8')).toBe(winner);
  expect(await store.listProjects()).toHaveLength(0);
});

it('label conflict leaves no marker', async () => {
  const target = path.join(root, 'target'); fs.mkdirSync(target);
  await store.createProject('P0101');
  await expect(createProjectCoordinated(store, { label: 'P0101', path: target }))
    .rejects.toThrow(/already exists/i);
  expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(false);
});

it('database failure leaves no marker', async () => {
  const target = path.join(root, 'db-failure'); fs.mkdirSync(target);
  vi.spyOn(store, 'createProject').mockRejectedValueOnce(new Error('sqlite busy'));
  await expect(createProjectCoordinated(store, { label: 'P0101', path: target }))
    .rejects.toThrow(/sqlite busy/i);
  expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(false);
});

it('preflight failure leaves database and marker unchanged', async () => {
  const target = path.join(root, 'unwritable'); fs.mkdirSync(target);
  await expect(createProjectCoordinated(store, { label: 'P0101', path: target }, {
    preflight: () => { throw new Error('permission denied'); },
  })).rejects.toThrow(/permission denied/i);
  expect(await store.listProjects()).toHaveLength(0);
  expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(false);
});

it('marker I/O failure reports committed label, canonical path, and shell-safe recovery', async () => {
  const target = path.join(root, "target with ' quote"); fs.mkdirSync(target);
  const fail = () => { throw new Error('disk full'); };
  await expect(createProjectCoordinated(store, { label: 'P0101', path: target }, {
    sessionId: () => 'fresh', writeExclusive: fail,
  })).rejects.toThrow("P0101");
  await expect(createProjectCoordinated(store, { label: 'P0102', path: target }, {
    sessionId: () => 'fresh', writeExclusive: fail,
  })).rejects.toThrow("tim bind-project --label 'P0102' --cwd '");
  expect((await store.listProjects()).map(p => p.label)).toEqual(['P0101', 'P0102']);
});

it('reports a post-preflight race without overwriting or unsafe bind advice', async () => {
  const target = path.join(root, 'race'); fs.mkdirSync(target);
  const raceWriter: typeof writeMarkerExclusive = (cwd, requested) => {
    writeMarkerExclusive(cwd, { ...requested, project: 'P0109', session: 'winner' });
    return writeMarkerExclusive(cwd, requested);
  };
  await expect(createProjectCoordinated(store, { label: 'P0101', path: target }, {
    sessionId: () => 'loser', writeExclusive: raceWriter,
  })).rejects.toThrow(/P0101.*P0109.*reconciliation/i);
  expect(readMarker(target)?.project).toBe('P0109');
  expect((await store.listProjects()).map(p => p.label)).toEqual(['P0101']);
});

it('safe recovery resolves the live label and is idempotent but never overwrites another label', async () => {
  const target = path.join(root, 'recover'); fs.mkdirSync(target);
  await store.createProject('P0101', { content: 'Recover me' });
  expect(await recoverProjectBinding(store, { label: 'P0101', path: target, sessionId: 's1' }))
    .toMatchObject({ alreadyBound: false, projectPath: target });
  expect(await recoverProjectBinding(store, { label: 'P0101', path: target, sessionId: 's2' }))
    .toMatchObject({ alreadyBound: true });
  await expect(recoverProjectBinding(store, { label: 'P0102', path: target }))
    .rejects.toThrow(/Project not found: P0102/);
  expect(readMarker(target)?.project).toBe('P0101');
});
```

- [ ] **Step 2: Run the focused test and observe red**

Run: `npx vitest run packages/tim-hooks/src/__tests__/project-creation.test.ts`

Expected: FAIL in bound-flow and recovery tests because the service still throws the temporary bound-branch error.

- [ ] **Step 3: Implement exact conflict and partial-failure errors plus bound orchestration**

Add these exports/helpers and replace the bound branch:

```ts
export class ProjectCreationPartialFailureError extends Error {
  constructor(message: string, public readonly createdLabel: string, public readonly projectPath: string) {
    super(message); this.name = 'ProjectCreationPartialFailureError';
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function localMarkerLabel(projectPath: string): string | null {
  if (!fs.existsSync(markerPath(projectPath))) return null;
  return readMarker(projectPath)?.project ?? 'unknown/corrupt';
}

// In createProjectCoordinated, after canonicalDirectory:
const existing = localMarkerLabel(projectPath);
if (existing) {
  throw new Error(
    `Path already has local marker ${existing}; remove it or explicitly rebind before creating a project.`,
  );
}
runtime.preflight(projectPath);
const resolved = await store.resolveProjectLabel(args.label);
if (resolved.status !== 'not_found') throw new Error(`Project label already exists: ${args.label}`);
const entry = await store.createProject(args.label, {
  content: args.content,
  aliases: args.aliases,
  metadata: { ...(args.metadata ?? {}), path: projectPath },
});
const marker: ProjectMarker = {
  version: 2, project: args.label, session: runtime.sessionId(), exchanges: 0,
  batch_size: 5, batches_summarized: 0,
};
try {
  runtime.writeExclusive(projectPath, marker);
} catch (error) {
  const winner = localMarkerLabel(projectPath);
  if (winner) {
    throw new ProjectCreationPartialFailureError(
      `Database project ${args.label} was created for ${projectPath}, but local marker ${winner} won a race. Explicit reconciliation is required; the winner was not overwritten.`,
      args.label, projectPath,
    );
  }
  const recovery = `tim bind-project --label ${shellQuote(args.label)} --cwd ${shellQuote(projectPath)}`;
  throw new ProjectCreationPartialFailureError(
    `Database project ${args.label} was created for ${projectPath}, but marker publication failed: ${(error as Error).message}. Recover with: ${recovery}`,
    args.label, projectPath,
  );
}
const verified = fs.existsSync(markerPath(projectPath)) ? readMarker(projectPath) : null;
if (verified?.project !== args.label) {
  if (verified) {
    throw new ProjectCreationPartialFailureError(
      `Database project ${args.label} was created for ${projectPath}, but marker verification found ${verified.project}. Explicit reconciliation is required; the marker was not overwritten.`,
      args.label, projectPath,
    );
  }
  throw new ProjectCreationPartialFailureError(
    `Database project ${args.label} was created for ${projectPath}, but marker verification failed. Recover with: tim bind-project --label ${shellQuote(args.label)} --cwd ${shellQuote(projectPath)}`,
    args.label, projectPath,
  );
}
return { ...entry, mode: 'bound', projectPath, markerPath: markerPath(projectPath) };
```

Add the recovery API:

```ts
export interface RecoverProjectBindingArgs { label: string; path: string; sessionId?: string }
export interface RecoverProjectBindingResult {
  label: string; projectPath: string; markerPath: string; alreadyBound: boolean;
}

export async function recoverProjectBinding(
  store: TimStore,
  args: RecoverProjectBindingArgs,
  deps: Partial<ProjectCreationDeps> = {},
): Promise<RecoverProjectBindingResult> {
  const runtime = { ...DEFAULT_DEPS, ...deps };
  const projectPath = canonicalDirectory(args.path);
  const resolved = await store.resolveProjectLabel(args.label);
  if (resolved.status !== 'found' || resolved.label !== args.label) {
    throw new Error(`Project not found: ${args.label}`);
  }
  const existing = localMarkerLabel(projectPath);
  if (existing === args.label) {
    return { label: args.label, projectPath, markerPath: markerPath(projectPath), alreadyBound: true };
  }
  if (existing) throw new Error(`Target already has local marker ${existing}; refusing to overwrite it.`);
  runtime.writeExclusive(projectPath, {
    project: args.label, session: args.sessionId ?? runtime.sessionId(), exchanges: 0,
    batch_size: 5, batches_summarized: 0,
  });
  if (readMarker(projectPath)?.project !== args.label) throw new Error(`Marker verification failed for ${args.label}`);
  return { label: args.label, projectPath, markerPath: markerPath(projectPath), alreadyBound: false };
}
```

- [ ] **Step 4: Run all hook tests and observe green**

Run: `npx vitest run packages/tim-hooks/src/__tests__/project-creation.test.ts packages/tim-hooks/src/__tests__/marker.test.ts`

Expected: PASS, including race/no-clobber assertions and no leftover preflight/temp files.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-hooks/src/project-creation.ts packages/tim-hooks/src/__tests__/project-creation.test.ts packages/tim-hooks/src/index.ts
git commit -m "feat(tim-hooks): coordinate bound project creation"
```

### Task 4: Enforce the contract through MCP

**Files:**
- Modify: `packages/tim-mcp/src/server.ts:407,480,733,2872`
- Create: `packages/tim-mcp/src/__tests__/create-project-contract.test.ts`

- [ ] **Step 1: Write a failing stdio MCP contract test**

Create the test with this stdio transport harness before the assertions:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import { readMarker } from 'tim-hooks';

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');
interface JsonRpcResp {
  id: number;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}
class McpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (response: JsonRpcResp) => void>();
  private buffer = '';
  private ready = false;
  constructor(dbPath: string, cwd: string) {
    this.proc = spawn('node', [SERVER_PATH], {
      cwd, env: { ...process.env, TIM_DB_PATH: dbPath }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', chunk => this.onData(chunk.toString('utf8')));
    this.proc.stderr!.on('data', () => {});
  }
  private onData(text: string): void {
    this.buffer += text;
    for (let newline = this.buffer.indexOf('\n'); newline !== -1; newline = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line) as JsonRpcResp;
      this.pending.get(response.id)?.(response);
      this.pending.delete(response.id);
    }
  }
  private send(method: string, params: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10_000);
      this.pending.set(id, response => { clearTimeout(timer); resolve(response); });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async init(): Promise<void> {
    if (this.ready) return;
    await this.send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'create-project-contract', version: '0.0.1' },
    });
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    this.ready = true;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<JsonRpcResp> {
    await this.init();
    return this.send('tools/call', { name, arguments: args });
  }
  kill(): void { this.proc.kill('SIGTERM'); }
}

describe('tim_create_project explicit binding contract', () => {
  let root: string; let dbPath: string; let serverCwd: string; let client: McpClient;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-mcp-create-'));
    dbPath = path.join(root, 'test.db'); serverCwd = path.join(root, 'server');
    fs.mkdirSync(serverCwd); client = new McpClient(dbPath, serverCwd); await client.init();
  });
  afterEach(() => { client.kill(); fs.rmSync(root, { recursive: true, force: true }); });
```

Continue the open `describe` block with these four tests:

```ts
it('requires exactly one explicit mode and creates nothing on rejection', async () => {
  const missing = await client.callTool('tim_create_project', { label: 'P8101' });
  expect(missing.result?.isError).toBe(true);
  expect(missing.result?.content[0].text).toMatch(/absolute project path.*memoryOnly: true/i);
  const store = new TimStore(dbPath);
  expect(await store.listProjects()).toHaveLength(0);
  store.close();
});

it('returns the entry plus memory-only mode and creates no cwd marker', async () => {
  const response = await client.callTool('tim_create_project', {
    label: 'P8101', content: 'Virtual', memoryOnly: true,
  });
  const payload = JSON.parse(response.result!.content[0].text);
  expect(payload).toMatchObject({ mode: 'memory-only', metadata: { label: 'P8101' } });
  expect(fs.existsSync(path.join(serverCwd, '.tim-project'))).toBe(false);
});

it('binds the exact explicit path and returns canonical paths', async () => {
  const target = path.join(root, 'bound'); fs.mkdirSync(target);
  const response = await client.callTool('tim_create_project', {
    label: 'P8102', content: 'Bound', path: target,
  });
  const payload = JSON.parse(response.result!.content[0].text);
  expect(payload).toMatchObject({
    mode: 'bound', projectPath: target, markerPath: path.join(target, '.tim-project'),
    metadata: { path: target, label: 'P8102' },
  });
  expect(readMarker(target)?.project).toBe('P8102');
});

it.each([
  { label: 'P8110', path: '/tmp', memoryOnly: true },
  { label: 'P8111', memoryOnly: false },
  { label: 'P8112', memoryOnly: true, metadata: { path: '/tmp/fake' } },
])('rejects invalid input %j without creating a project', async args => {
  const response = await client.callTool('tim_create_project', args);
  expect(response.result?.isError).toBe(true);
  const store = new TimStore(dbPath);
  expect((await store.listProjects()).some(p => p.label === args.label)).toBe(false);
  store.close();
});
});
```

- [ ] **Step 2: Run the focused test and observe red**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/create-project-contract.test.ts`

Expected: FAIL because omitted modes still create projects and bound result fields are absent.

- [ ] **Step 3: Replace the schema, description, and handler**

Import `createProjectCoordinated`, and keep the registry's existing `z.ZodObject<z.ZodRawShape>` type by defining a plain object schema. Mode validation stays in the shared service so MCP, CLI, and direct callers receive the same actionable error before any write:

```ts
const TimCreateProjectSchema = z.object({
  label: z.string().describe('Project label, e.g. P0062'),
  metadata: z.record(z.unknown()).optional().default({}),
  content: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  path: z.string().optional().describe('Absolute directory for every project representing files on disk'),
  memoryOnly: z.boolean().optional().describe(
    'Must be true, and only for an intentional database-only project; mutually exclusive with path',
  ),
});
```

Use this description:

```ts
'Create a project in exactly one mode. Every project representing files on disk MUST pass its absolute path; memoryOnly:true is only for an intentionally virtual/database-only project and is never a shortcut for an unknown cwd.'
```

Replace the handler with:

```ts
case 'tim_create_project': {
  const input = TimCreateProjectSchema.parse(args);
  const result = await createProjectCoordinated(s, input);
  return { content: [{ type: 'text', text: formatToolResponse(result) }] };
}
```

- [ ] **Step 4: Run the MCP contract test and observe green for stdio and transport-neutral service behavior**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/create-project-contract.test.ts packages/tim-mcp/src/__tests__/http-session-identity.test.ts`

Expected: the new contract test PASS; `http-session-identity` FAIL only at its two old call sites until Task 6 explicitly opts them into memory-only mode.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/create-project-contract.test.ts
git commit -m "feat(tim-mcp): require explicit project creation mode"
```

### Task 5: Migrate CLI creation and recovery to shared services

**Files:**
- Modify: `packages/tim-cli/src/new-project.ts:55-155,194-260`
- Modify: `packages/tim-cli/src/cli.ts:288-306`
- Modify: `packages/tim-cli/src/__tests__/new-project.test.ts:140-215,334-365`
- Modify: `packages/tim-cli/src/__tests__/resolve-project.test.ts:45-70`

- [ ] **Step 1: Change CLI tests to demand shared conflict/retry behavior and safe recovery**

Replace the overwrite-oriented `bind-project preserves existing counters` test with:

```ts
it('bind-project validates the label in the selected DB and is idempotent without overwriting', async () => {
  const db = path.join(dir, 'test.db');
  const store = new TimStore(db); await store.createProject('P0100'); store.close();
  const env = { TIM_DB_PATH: db, TIM_MARKER_MAX_ROOT: dir };
  run(['bind-project', '--cwd', dir, '--label', 'P0100'], env);
  const first = fs.readFileSync(path.join(dir, '.tim-project'), 'utf8');
  run(['bind-project', '--cwd', dir, '--label', 'P0100'], env);
  expect(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8')).toBe(first);
  expect(run(['bind-project', '--cwd', dir, '--label', 'P0101'], env)).toContain('Project not found');
  expect(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8')).toBe(first);
});
```

In `new-project.test.ts`, replace the prototype spy in `retries on label collision` with this dependency-injection assertion; retain the existing directory/confirmation, sections, `--no-git`, existing-git, and git-init tests unchanged:

```ts
const createProject = vi.fn<typeof createProjectCoordinated>();
createProject
  .mockRejectedValueOnce(new Error('Project label already exists: P0002 (dup-id)'))
  .mockImplementation(async (store, args) => {
    expect(fs.existsSync(path.join(target, '.tim-project'))).toBe(false);
    return createProjectCoordinated(store, args);
  });
await cmdNewProject(['--path', target, '--name', 'Collision Test'], { createProject });
expect(createProject.mock.calls.map(([, args]) => args.label)).toEqual(['P0002', 'P0003']);
expect(readMarker(target)?.project).toBe('P0003');
```

- [ ] **Step 2: Run the focused CLI tests and observe red**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/new-project.test.ts packages/tim-cli/src/__tests__/resolve-project.test.ts`

Expected: FAIL because `bind-project` still overwrites and `new-project` still calls `TimStore.createProject`/`writeMarker` directly.

- [ ] **Step 3: Delegate CLI database/marker work and keep UI-only behavior**

In `new-project.ts`, delete `validatePath`, the local marker conflict block, `createProjectWithRetry`'s direct store write, and the direct `writeMarker` block. Preserve argument parsing, name validation, directory creation before service canonicalization, confirmation, `initProjectSchema`, and git handling. Implement the retry around the coordinated service:

```ts
async function createBoundProjectWithRetry(
  store: TimStore, startLabel: string, name: string, targetPath: string,
  deps: NewProjectDeps,
): Promise<BoundProjectCreationResult> {
  let label = startLabel;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await deps.createProject(store, {
        label, path: targetPath, content: name,
        metadata: { name },
      }) as BoundProjectCreationResult;
    } catch (error) {
      if (isDupProjectError(error)) { label = incrementLabel(label); continue; }
      throw error;
    }
  }
  throw new Error(`Project label ${startLabel} race retry exhausted after 10 attempts`);
}
```

Define and thread the exact dependency hook without changing normal callers:

```ts
export interface NewProjectDeps {
  createProject: typeof createProjectCoordinated;
}
const DEFAULT_NEW_PROJECT_DEPS: NewProjectDeps = { createProject: createProjectCoordinated };
```

Change the existing function signature to `export async function cmdNewProject(args: string[], deps: NewProjectDeps = DEFAULT_NEW_PROJECT_DEPS): Promise<void>`. At its current database-write site, use this exact call:

```ts
const result = await createBoundProjectWithRetry(
  store, store.allocateNextProjectLabel(), name.trim(), targetPath, deps,
);
```

Keep the current surrounding help, mkdir, confirmation, `initProjectSchema`, and git blocks byte-for-byte except for variables replaced by `result`.

Use `result.metadata.label` and `result.id` for the final output/section initialization. Do not catch and rewrite `ProjectCreationPartialFailureError`; print its already actionable message and exit 1. This keeps the shared service as the only registration/marker implementation.

Replace `cmdBindProject` with:

```ts
async function cmdBindProject(args: string[]) {
  const flags = parseArgs(args);
  const cwd = flags.cwd ?? process.cwd();
  const label = flags.label;
  if (!label) {
    console.error('Usage: tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]');
    process.exit(1);
  }
  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
  try {
    const result = await recoverProjectBinding(store, {
      label, path: cwd, sessionId: flags.session,
    });
    console.log(result.alreadyBound
      ? `.tim-project already binds ${label} at ${result.projectPath}`
      : `Wrote .tim-project → ${label} at ${result.projectPath}`);
  } finally { store.close(); }
}
```

- [ ] **Step 4: Run CLI tests and observe green**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/new-project.test.ts packages/tim-cli/src/__tests__/resolve-project.test.ts`

Expected: PASS; label-race retry happens before a marker is committed, existing local markers behave identically to MCP, and git/sections/confirmation behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-cli/src/new-project.ts packages/tim-cli/src/cli.ts packages/tim-cli/src/__tests__/new-project.test.ts packages/tim-cli/src/__tests__/resolve-project.test.ts
git commit -m "refactor(tim-cli): share coordinated project creation"
```

### Task 6: Migrate intentional database-only MCP fixtures

**Files:**
- Modify: `packages/tim-mcp/src/__tests__/error-contract.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/http-session-identity.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/import-audit-tools.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/load-project-bind.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/read-depth-defaults.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/read-search-write-ext.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/recall-tools.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/show-output.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/stats-output.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/test-tim-stats-delete-tools.test.ts`
- Modify: `packages/tim-mcp/src/__tests__/write-dedup.test.ts`

- [ ] **Step 1: Confirm every legacy call fails for the intended reason**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__`

Expected: FAIL wherever `tim_create_project` omits both `path` and `memoryOnly`.

- [ ] **Step 2: Explicitly opt every administrative fixture into memory-only mode**

For every `client.callTool('tim_create_project', { ... })` and SDK `{ name: 'tim_create_project', arguments: { ... } }` in the eleven files, add the concrete property `memoryOnly: true` inside that call's argument object. Example transformations:

```ts
await client.callTool('tim_create_project', {
  label: 'P8101', content: 'Project 8101', memoryOnly: true,
});

await clientA.callTool({
  name: 'tim_create_project',
  arguments: { label: 'P9001', content: 'Project 1 for test', memoryOnly: true },
});
```

Do not change direct `store.createProject` calls: those are intentionally low-level fixtures and the approved design keeps that API unchanged.

- [ ] **Step 3: Prove no ambiguous MCP fixture remains**

Run:

```bash
rg -n -U "tim_create_project[\s\S]{0,220}" packages/tim-mcp/src/__tests__
npx vitest run packages/tim-mcp/src/__tests__
```

Expected: inspection shows every creation has `path` or `memoryOnly: true`; all MCP tests PASS, including HTTP and stdio.

- [ ] **Step 4: Commit**

```bash
git add packages/tim-mcp/src/__tests__
git commit -m "test(tim-mcp): declare memory-only project fixtures"
```

### Task 7: Migrate production skill guidance and CLI documentation

**Files:**
- Create: `packages/tim-skills/skills/tim-new-project/SKILL.md`
- Create: `packages/tim-skills/src/tim-new-project.ts`
- Modify: `packages/tim-skills/src/index.ts:1-45`
- Modify: `packages/tim-skills/src/__tests__/skills.test.ts`
- Modify: `docs/tim-cli-reference.md:210-240`

- [ ] **Step 1: Write the failing packaged-skill guard**

Add:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TIM_NEW_PROJECT_SKILL } from '../index.js';

it('tim-new-project requires path for disk projects and reserves memoryOnly for virtual projects', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '../../skills/tim-new-project/SKILL.md'), 'utf8',
  );
  expect(text).toContain('path="/absolute/path/to/repository"');
  expect(text).toContain('memoryOnly=true');
  expect(text).toMatch(/never use memoryOnly/i);
  expect(text).toContain('markerPath');
  expect(TIM_NEW_PROJECT_SKILL.content).toContain('path="/absolute/path/to/repository"');
  expect(getSkill('tim-new-project')).toBe(TIM_NEW_PROJECT_SKILL);
  expect(listSkills().map(skill => skill.name)).toContain('tim-new-project');
});
```

- [ ] **Step 2: Run it and observe red**

Run: `npx vitest run packages/tim-skills/src/__tests__/skills.test.ts`

Expected: FAIL with `ENOENT` for the new bundled skill.

- [ ] **Step 3: Add canonical guidance and document recovery semantics**

Create `SKILL.md` with this exact content:

```md
---
name: tim-new-project
description: Create explicitly bound or intentional memory-only TIM projects safely.
---

# TIM New Project

1. If the project represents files on disk, obtain and canonicalize the repository/workspace directory.
2. Allocate a non-conflicting P-label in the configured TIM database.
3. Call `tim_create_project(label="P00XX", content="Name | Active | Stack | Description", aliases=["short-name"], path="/absolute/path/to/repository")`.
4. Treat success as valid only when `mode` is `bound` and `markerPath` is the repository's own `.tim-project`.
5. Load the returned label and fill its sections.

For an intentionally virtual project with no directory, call `tim_create_project(..., memoryOnly=true)`. Never use memoryOnly because cwd is unknown; ask for or discover the absolute repository path.

If marker publication fails after database creation, run only the returned shell-quoted `tim bind-project` recovery command against the same configured database. A different existing local marker requires explicit reconciliation and must not be overwritten.
```

Create the runtime export with identical operative text:

```ts
export const TIM_NEW_PROJECT_SKILL = {
  name: 'tim-new-project',
  description: 'Create explicitly bound or intentional memory-only TIM projects safely.',
  content: `# TIM New Project

1. For files on disk, obtain the canonical repository/workspace directory.
2. Allocate a non-conflicting P-label in the configured TIM database.
3. Call tim_create_project with label, content, aliases, and path="/absolute/path/to/repository".
4. Accept bound success only when mode is bound and markerPath is the repository-local .tim-project.
5. Load the returned label and fill its sections.

For an intentionally virtual project with no directory, pass memoryOnly=true. Never use memoryOnly because cwd is unknown; obtain the absolute path.

After a partial marker failure, run only the returned shell-quoted tim bind-project recovery command against the same configured database. Never overwrite a different local marker.
`,
};
```

In `src/index.ts`, import/export `TIM_NEW_PROJECT_SKILL`, append it once to `ALL_TIM_SKILLS`, and change the existing exact-count test name/expectation from eleven to twelve.

In `docs/tim-cli-reference.md`, state that `new-project` is a coordinated operation rather than an atomic transaction, and that `bind-project` resolves the label in the selected database, writes only when no local marker exists, and is idempotent for the same label.

- [ ] **Step 4: Run skill tests and an installed-copy dry run**

Run:

```bash
npx vitest run packages/tim-skills/src/__tests__/skills.test.ts
node packages/tim-cli/dist/cli.js update-skills --host hermes --dry-run
```

Expected: skill tests PASS. If `update-skills` does not support these flags, run `npm pack --dry-run --workspace tim-skills` instead and confirm `skills/tim-new-project/SKILL.md` appears; do not mutate user skill directories during this test.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-skills/skills/tim-new-project/SKILL.md packages/tim-skills/src/tim-new-project.ts packages/tim-skills/src/index.ts packages/tim-skills/src/__tests__/skills.test.ts docs/tim-cli-reference.md
git commit -m "docs: require paths when agents create projects"
```

### Task 8: Rebuild, verify, and recover o9k in the live database

**Files:**
- Create generated: `packages/tim-hooks/dist/project-creation.js`, `packages/tim-hooks/dist/project-creation.js.map`, `packages/tim-hooks/dist/project-creation.d.ts`, `packages/tim-hooks/dist/project-creation.d.ts.map`
- Modify generated: `packages/tim-hooks/dist/marker.js`, `packages/tim-hooks/dist/marker.js.map`, `packages/tim-hooks/dist/marker.d.ts`, `packages/tim-hooks/dist/marker.d.ts.map`, `packages/tim-hooks/dist/index.js`, `packages/tim-hooks/dist/index.js.map`, `packages/tim-hooks/dist/index.d.ts`, `packages/tim-hooks/dist/index.d.ts.map`
- Modify generated: `packages/tim-mcp/dist/server.js`, `packages/tim-mcp/dist/server.js.map`, `packages/tim-mcp/dist/server.d.ts`, `packages/tim-mcp/dist/server.d.ts.map`
- Modify generated: `packages/tim-cli/dist/new-project.js`, `packages/tim-cli/dist/new-project.js.map`, `packages/tim-cli/dist/new-project.d.ts`, `packages/tim-cli/dist/new-project.d.ts.map`, `packages/tim-cli/dist/cli.js`, `packages/tim-cli/dist/cli.js.map`, `packages/tim-cli/dist/cli.d.ts`, `packages/tim-cli/dist/cli.d.ts.map`
- Create generated: `packages/tim-skills/dist/tim-new-project.js`, `packages/tim-skills/dist/tim-new-project.js.map`, `packages/tim-skills/dist/tim-new-project.d.ts`, `packages/tim-skills/dist/tim-new-project.d.ts.map`
- Modify generated: `packages/tim-skills/dist/index.js`, `packages/tim-skills/dist/index.js.map`, `packages/tim-skills/dist/index.d.ts`, `packages/tim-skills/dist/index.d.ts.map`
- Create live marker after all gates pass: `/home/bbbee/projects/o9k/.tim-project`
- Modify live state after all gates pass: configured TIM database selected by `TIM_DB_PATH`/`loadConfig()`

- [ ] **Step 1: Build from a clean generated baseline**

Run:

```bash
npm run clean
npm run build
git status --short
```

Expected: build exits 0; only expected source/docs/tests and committed `dist` outputs differ. No `tsconfig.tsbuildinfo`, temp marker, or database file is staged.

- [ ] **Step 2: Prove generated code contains the new contract**

Run:

```bash
rg -n "createProjectCoordinated|memory-only|writeMarkerExclusive" packages/tim-hooks/dist packages/tim-mcp/dist packages/tim-cli/dist
git diff --check
```

Expected: all three contract strings are present and `git diff --check` prints nothing.

- [ ] **Step 3: Commit only generated outputs**

```bash
git add packages/tim-hooks/dist packages/tim-mcp/dist packages/tim-cli/dist packages/tim-skills/dist
git commit -m "chore: rebuild dist for project path binding"
```

#### Acceptance verification before live recovery

**Files:** none

- [ ] **Step 1: Run focused contract suites**

Run:

```bash
npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts packages/tim-hooks/src/__tests__/project-creation.test.ts packages/tim-mcp/src/__tests__/create-project-contract.test.ts packages/tim-cli/src/__tests__/new-project.test.ts packages/tim-cli/src/__tests__/resolve-project.test.ts packages/tim-skills/src/__tests__/skills.test.ts
```

Expected: PASS with no test writing outside its temporary directory.

- [ ] **Step 2: Run repository-wide gates**

Run:

```bash
npm run lint
npm test
npm run build
git diff --check
git status --short
```

Expected: lint/build exit 0, the complete Vitest suite passes with only documented skips, `git diff --check` is empty, and the worktree is clean.

- [ ] **Step 3: Audit acceptance language and scope**

Run:

```bash
rg -n "atomic project creation|implicit cwd|process\.cwd\(\).*tim_create_project" packages docs/tim-cli-reference.md
rg -n "SessionStart hook|additionalContext" packages/tim-hooks/src/project-creation.ts packages/tim-mcp/src/server.ts packages/tim-cli/src/new-project.ts
```

Expected: no claim that database plus marker creation is atomic, no MCP cwd fallback, and no SessionStart-hook change in this branch.

#### Live o9k recovery through the shipped service

**Files/state:**
- Create live marker: `/home/bbbee/projects/o9k/.tim-project`
- Modify configured live TIM database only through public TypeScript APIs; never use raw SQL

- [ ] **Step 1: Confirm installation, configured DB, and absence of local marker**

Run:

```bash
npm run build
node packages/tim-cli/dist/cli.js doctor
test ! -e /home/bbbee/projects/o9k/.tim-project
```

Expected: doctor prints `DB: /home/bbbee/.tim/tim.db` (or the explicitly configured live path), never `/tmp/tim.db`; the marker absence check exits 0. Stop if a local marker appeared and reconcile it explicitly.

- [ ] **Step 2: List live projects and allocate a fresh label without SQL**

Run this read-only API script:

```bash
node --input-type=module <<'NODE'
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from 'tim-core';
import { TimStore } from 'tim-store';
const config = loadConfig();
const dbPath = process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
if (dbPath === '/tmp/tim.db') throw new Error('Refusing accidental /tmp/tim.db');
const store = new TimStore(dbPath);
console.log(JSON.stringify({ dbPath, projects: (await store.listProjects()).map(p => ({ label: p.label, title: p.title })), nextLabel: store.allocateNextProjectLabel() }, null, 2));
store.close();
NODE
```

Expected: output lists the live projects, shows `P0048` already occupied, and prints a different available `nextLabel`. Record that exact label as `NEW_LABEL`; do not import or inspect the accidental temp database.

- [ ] **Step 3: Create the bound o9k project through the shared service**

Run, replacing the shell value with the exact allocator output from Step 2:

```bash
NEW_LABEL=P0064 node --input-type=module <<'NODE'
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from 'tim-core';
import { TimStore } from 'tim-store';
import { createProjectCoordinated } from 'tim-hooks';
const config = loadConfig();
const dbPath = process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
if (dbPath === '/tmp/tim.db') throw new Error('Refusing accidental /tmp/tim.db');
const label = process.env.NEW_LABEL;
if (!label || label === 'P0048') throw new Error('NEW_LABEL must be the fresh live allocator result');
const store = new TimStore(dbPath);
try {
  const result = await createProjectCoordinated(store, {
    label,
    path: '/home/bbbee/projects/o9k',
    content: 'its-over-9k (o9k) | Active | Meta-framework for AI coding agents',
    aliases: ['o9k'],
    metadata: { name: 'its-over-9k (o9k)' },
  });
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); }
NODE
```

Expected: success has `mode: "bound"`, the recorded fresh label, `projectPath: "/home/bbbee/projects/o9k"`, and `markerPath: "/home/bbbee/projects/o9k/.tim-project"`. The literal `P0064` is an example shell value only; use the actual allocator result, never reuse a conflicting label.

- [ ] **Step 4: Verify exact marker resolution beats the ancestor and the statusline names o9k**

Run:

```bash
node packages/tim-cli/dist/cli.js resolve-project --cwd /home/bbbee/projects/o9k --walk-up --format json
node packages/tim-cli/dist/cli.js statusline --cwd /home/bbbee/projects/o9k
```

Expected: JSON `dir` is exactly `/home/bbbee/projects/o9k`, `project` is `NEW_LABEL`, and statusline begins `its-over-9k (o9k) · 0/5 exchanges · summary in 5`, not `bbbee PM Workflow`.

- [ ] **Step 5: Verify a genuinely fresh o9k session**

Close the pre-existing Claude Code session, start a new one with `cd /home/bbbee/projects/o9k && claude`, and inspect the first rendered statusline before doing project work.

Expected: the fresh session names `its-over-9k (o9k)` (or its unambiguous o9k display name) and loads `NEW_LABEL`; it never names `bbbee PM Workflow`. This step does not fix or modify the separate Claude `SessionStart hook (failed)` transport bug.

## Self-review checklist

- [x] Every approved mode rule is covered: neither, both, `memoryOnly:false`, and caller-owned `metadata.path` fail before writes.
- [x] Bound paths are absolute, shorthand-free, canonicalized after CLI directory creation, non-home directories, and authoritative in metadata/result.
- [x] Only the target-local marker conflicts; ancestor discovery behavior is unchanged.
- [x] Writability and label checks precede database creation; database failure creates no marker.
- [x] Same-directory temp plus atomic no-clobber link prevents race overwrites and cleans residue.
- [x] Marker failure reports the committed label, canonical path and safely quoted recovery; race failure names both labels without overwrite advice.
- [x] Successful bound results preserve entry fields and add verified `mode`, `projectPath`, and `markerPath`; memory-only results have no marker fields.
- [x] CLI/MCP share one service; CLI alone retains confirmation, mkdir, sections, label retry and git setup.
- [x] HTTP and stdio share the same MCP handler and every intentional fixture explicitly says `memoryOnly:true`.
- [x] Production agent guidance uses `path` for disk-backed work and never treats `memoryOnly` as unknown-cwd fallback.
- [x] Distribution artifacts, focused tests, full tests, lint, build, and clean-worktree checks are explicit.
- [x] o9k recovery uses the configured live DB, API label allocation, a fresh non-P0048 label, no SQL, no temp-DB import, exact local-marker and fresh-statusline verification.
- [x] The separate Claude SessionStart hook fix is excluded.
