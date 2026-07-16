# Project Creation Must Declare Its Binding Mode

**Date:** 2026-07-16
**Status:** Approved design, pending implementation plan

## Problem

TIM has two incompatible project-creation paths:

- `tim new-project` creates a database project and writes `<path>/.tim-project`.
- MCP `tim_create_project` accepts no path and calls `TimStore.createProject` only.

This lets an agent believe it registered a filesystem project while leaving the directory
unbound. A later session can then walk up to an unrelated ancestor marker. That is what
happened for `/home/bbbee/projects/o9k`: the agent called `tim_create_project` with `P0048`
against `/tmp/tim.db`, so neither a live-database o9k project nor an o9k-local marker was
created. In the live database, `P0048` already belongs to another project.

The defect is not marker discovery itself. Creation silently discarded the filesystem
identity that a durable project requires.

## Goals

1. Make every MCP project creation explicitly filesystem-bound or explicitly memory-only.
2. Give CLI and MCP one implementation for path validation, conflict checks, database
   registration, and marker creation.
3. Never report successful filesystem project creation unless the result identifies the
   marker that was written.
4. Make partial failure visible and recoverable without claiming filesystem and SQLite
   changes form one transaction.
5. Recover o9k in the live database after the implementation ships.

## Non-Goals

- Changing `.tim-project` discovery or walk-up behavior.
- Automatically deriving a path from the MCP server's `process.cwd()`.
- Moving, merging, or importing the accidental `/tmp/tim.db` project.
- Making database and filesystem writes truly atomic.
- Fixing the separately diagnosed Claude Code `SessionStart` hook failure.

## Public Contract

`tim_create_project` adds two mutually exclusive inputs:

```ts
{
  label: string;
  content?: string;
  metadata?: Record<string, unknown>;
  aliases?: string[];
  path?: string;
  memoryOnly?: true;
}
```

Exactly one creation mode is required:

- `path` creates a filesystem project and binds that exact directory.
- `memoryOnly: true` creates a database-only project intentionally.

Calls with neither, with both, or with `memoryOnly: false` and no path are rejected before
any write. The error says to pass an absolute project path for a repository/workspace, or
`memoryOnly: true` only when no directory should be bound. There is no implicit cwd fallback,
including for stdio MCP, because server cwd is not reliable project identity.

`metadata.path` becomes service-owned: bound creation always stores the canonical `path`
argument, and memory-only creation rejects a caller-supplied `metadata.path`. This prevents
the old unbound behavior from being recreated through metadata alone.

For a bound creation, the successful response preserves the existing entry fields at the
top level and adds:

```ts
{
  mode: "bound";
  projectPath: string; // canonical absolute directory
  markerPath: string;  // canonical absolute <projectPath>/.tim-project
}
```

A memory-only response uses `mode: "memory-only"` and has no marker fields. Tool descriptions
and skill guidance must tell agents: every project representing files on disk passes `path`;
`memoryOnly` is never a shortcut for an unknown cwd.

## Shared Creation Service

Add a project-creation service in `tim-hooks` (which can depend on `tim-store` and owns marker
I/O). Both `tim new-project` and MCP `tim_create_project` call it. `TimStore.createProject`
remains a low-level database primitive for store internals and fixtures; it does not acquire
filesystem semantics.

The service accepts a store plus the public creation arguments and returns the mode-specific
result. The CLI keeps its presentation, confirmation, optional directory creation, standard
section initialization, and optional `git init`; those are not MCP behavior. Shared code owns
the database registration and marker binding that define bound creation.

### Bound creation sequence

1. Validate mode before writes.
2. Require `path` to be absolute and free of `~`/environment-variable shorthand. Resolve
   symlinks to a canonical absolute directory after CLI-created directories exist. Reject
   the home directory and non-directory targets.
3. Inspect only the target directory's own `.tim-project`; an ancestor marker is not a
   conflict because the new local marker must override it. Reject any existing local marker,
   including one for the requested label, with explicit rebind/remove guidance. Do not
   overwrite it.
4. Preflight directory writability by creating and removing a uniquely named temporary file
   beside the future marker. Confirm the requested label does not conflict in the selected
   store. These checks reduce, but cannot eliminate, races.
5. Create the database project with canonical `metadata.path`.
6. Write `.tim-project` through a new exclusive atomic writer in `tim-hooks`, with the created
   label, a fresh session id, and neutral counters. The writer must publish a complete temp
   file without replacing a marker created by a racing process (for example, same-directory
   temp file plus atomic no-clobber link). Confirm the file exists and reads back as that label.
7. Return the canonical project and marker paths.

`tim new-project` must no longer contain a second database/marker implementation. Its label
allocation retry remains coordinated with the shared service: a label race retries before
any marker is committed.

### Failure and recovery contract

SQLite and rename-based marker I/O cannot be one transaction. The implementation must say
"coordinated operation," not "atomic project creation."

- Validation, marker conflict, or preflight failure leaves database and marker state
  unchanged (the CLI may already have created the requested directory).
- Database failure leaves no marker.
- Marker I/O failure after database commit returns an error (never success) containing the
  created label, canonical target path, and safely shell-quoted recovery command:
  `tim bind-project --label <label> --cwd <path>`.
- If a racing process created a marker after preflight, return the created database label and
  the marker's current label, and require explicit reconciliation. Do not suggest a command
  that would overwrite the winner.
- Recovery is idempotent: first resolve the label in the same database, then bind only if
  the target still has no local marker. Never delete the database project automatically,
  because another process may already reference it.

## MCP and Skill Migration

All production skill/examples that create a real project must pass its canonical path.
Database-only tests, administrative fixtures, and intentionally virtual projects must add
`memoryOnly: true`. This deliberate call-site migration prevents the old silent behavior
from surviving through defaults.

The MCP schema description must expose the exclusive-mode rule and the error must remain
actionable even when a client omits newly added fields. HTTP and stdio transports follow the
same contract.

## Tests

### Shared service

- Reject neither mode, both modes, relative/shorthand paths, home, and non-directories before
  database or filesystem mutation.
- Reject `metadata.path` in memory-only mode and make canonical `path` authoritative in bound
  mode.
- Canonicalize symlinked paths and persist the canonical value in metadata and response.
- Reject an existing target-local marker without changing it or creating a database project.
- Simulate a marker appearing after preflight and assert it is not overwritten; report the
  already-created database project and recovery path.
- Ignore an ancestor marker and write the required marker in the explicit target directory.
- Create the database project and readable v2 marker with matching label; return `markerPath`.
- Simulate database and marker-write failures and assert the documented state and
  recovery text for each phase.

### MCP and CLI regression

- `tim_create_project` without `path` or `memoryOnly: true` is an error and creates nothing.
- `memoryOnly: true` creates no marker and returns `mode: "memory-only"`.
- A path-bound MCP call returns the canonical marker path and writes the local marker.
- Existing MCP suites explicitly opt into memory-only fixtures.
- CLI uses the shared service while preserving confirmation, label-race retry, and `git init`
  behavior.
- Conflict behavior is identical through CLI and MCP, and all existing suites remain green.

## o9k Recovery Runbook

After the contract is implemented and installed:

1. Use the configured live TIM database, not `/tmp/tim.db`, and list live projects.
2. Allocate the next available non-conflicting project label; do not reuse `P0048`.
3. Call the new bound creation path with `/home/bbbee/projects/o9k`, the agreed o9k name,
   and alias `o9k`.
4. Verify the returned marker is exactly `/home/bbbee/projects/o9k/.tim-project`, resolves to
   the new live project, and wins over `/home/bbbee/projects/.tim-project` from the o9k cwd.
5. Start a fresh session in o9k and confirm its statusline names the o9k project.

The accidental `/tmp/tim.db` entry is diagnostic residue and is not a migration source.

## Out-of-Scope Follow-up: Claude Code SessionStart

Claude Code's recurring `SessionStart hook (failed)` has already been diagnosed separately:
the hook mishandles the real `SessionStart` payload and emits the wrong response envelope
(`context` instead of `hookSpecificOutput.additionalContext`). Fix and regression-test that
hook in a separate change so its transport contract is not conflated with project creation.

## Acceptance Criteria

- No MCP caller can silently create an unbound project.
- CLI and MCP bound creation share one orchestration path.
- A successful bound result names a verified local marker; failures describe actual partial
  state and safe recovery.
- Filesystem-project guidance passes `path`; only intentional virtual/test creation passes
  `memoryOnly: true`.
- o9k is recoverable into the live database with a fresh label and its own marker.
