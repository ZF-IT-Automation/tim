# Slim `.tim-project` to Binding-Only; Runtime State Moves Into the Store

**Date:** 2026-07-19
**Status:** Approved design — implementation plan: `docs/superpowers/plans/2026-07-19-marker-slimming.md`

## Problem

The `.tim-project` marker conflates three roles with very different lifetimes:

1. **cwd→project binding** (`project`) — stable, changes only on rebind.
2. **Current session id** (`session`) — rotates every session start.
3. **Runtime counters** (`exchanges`, `batch_size`, `batches_summarized`) — mutate
   every exchange.

Roles 2 and 3 make the marker a mutable runtime file, and most of the marker
apparatus exists to keep a mutable file honest: atomic writes, the exclusive
no-clobber writer, session rotation (PITFALLS-46), `reconcileMarker`,
corruption handling, `validateMarkerAgainstStore` (the P9999 bug),
`isUnsafeMarkerDir` (the `/tmp/.tim-project` leak), and stale-marker
directives in the CLI.

The counters are already distrusted in practice. `maybeSpawnSummarizer` calls
`reconcileMarker`, which re-derives them from the DB tree via `deriveCounters`
("authoritative — never trusts caches") before making any decision. The
on-disk counters therefore carry no authority — only churn. `batch_size` is
additionally persisted on the session entry (`session.metadata.batch_size`),
so the marker copy is redundant. The only load-bearing runtime field is
`session`, consumed by the summarizer spawn gate.

### Considered and rejected: DB-only binding via per-device paths

An alternative was evaluated: drop marker files entirely and record, on each
project root node, the project directory per device
(`metadata.paths = { <device>: <path> }`), resolving cwd→project by path
lookup in the store. Rejected as the *binding* mechanism for three reasons:

1. **Row-level LWW sync.** `sync-methods.ts` merges entries per row
   (`metadata = excluded.metadata`, `lww_device`). Two devices concurrently
   writing their own path into the same root-node metadata lose one write on
   sync. Marker files avoid this class structurally because per-device state
   never leaves the device.
2. **Registration replaces self-location.** Every clone, worktree, moved or
   renamed directory needs an explicit registration step, and stale paths
   replicate to *all* devices instead of rotting locally. The stale-state bug
   class does not disappear; it migrates into the synced store.
3. **Ephemeral environments.** CI runners and remote workers get a fresh path
   and device identity every run. Committed `tim.json` binds them today with
   zero store state; a path registry cannot.

A per-device path *inventory* in the store is still useful as information
(see below) — it is just not a binding source.

## Goals

1. Reduce on-disk binding state to the stable project label only.
2. Make the store authoritative for the current session id and all counters;
   delete the marker's runtime fields and the machinery that maintains them
   (`rotateMarkerSession`, `reconcileMarker`, per-session marker rewrites).
3. Keep the existing resolution order and discovery semantics: nearest
   `.tim-project` (now label-only) wins over `tim.json`, which wins over
   `~/.tim/active-project` / Inbox.
4. Add an informational per-device path inventory in the store, structured to
   survive row-level LWW sync.
5. Preserve every existing corruption defense (label pattern, P9999 DB gate,
   unsafe-dir refusal) on the slimmed schema.
6. Give the hmem→TIM migration a binding step: after import, write a marker
   into each imported project's directory where that is safely possible, and
   report the projects where it is not.

## Non-Goals

- Making the DB path inventory a binding source, now or as a hidden fallback.
- Changing marker discovery, walk-up policies, or the cwd-only auto-load
  contract in `checkpoint.ts`.
- Removing `tim.json` or changing its committed-default semantics.
- Sync-protocol changes (no metadata merge/CRDT work).
- Changing the bound-creation contract from the 2026-07-16 project-path-binding
  design; only the *content* the exclusive writer emits gets smaller.

## Marker v3

```json
{ "version": 3, "project": "P0063" }
```

- `readMarker` normalizes v1/v2 files to the v3 view by ignoring the runtime
  fields; the label pattern check and the `tim.json` fallback are unchanged.
  Corrupt files still return null and still shadow `tim.json` in the same
  directory (no silent fallback).
- Writes become rare: `tim new-project` / `tim bind-project` / phantom-recovery
  repair. Session start no longer rewrites the marker; it writes one only when
  no local marker exists and the binding came from an explicit `projectId`
  (today's auto-bind behavior, minus the counter payload). A v1/v2 file is
  upgraded to v3 on the next such write, never eagerly.
- `writeMarkerExclusive` (bound creation) and all validation gates keep their
  contracts; `ProjectMarker` loses the runtime fields, `ProjectMarkerInput`
  collapses into it.

## Where the runtime state goes

**Current session id.** Harness payloads carry `session_id` on both
SessionStart and Stop; hooks thread it through instead of reading the marker.
For callers without a payload session (statusline, manual CLI), the store
answers it: the latest `kind=session` entry for the project whose
`metadata.cwd` matches, which `startProjectSession` already records. A small
`resolveCurrentSession(store, projectLabel, cwd)` helper in `tim-store` wraps
that query.

**Counters.** `maybeSpawnSummarizer` drops `detectProject` +
`reconcileMarker` and calls `deriveCounters` directly on the resolved session.
The spawn-gate math (`pending = exchanges − batchesSummarized × batchSize`,
with `batch_size` read from session metadata) is unchanged. The
checkpoint-cadence reminder in `runSessionStart` reads the same derived
counters instead of `marker.exchanges`.

**Summarizer lock.** `.tim-project.lock` is a process lock, not marker state.
It moves to `.tim/summarizer.lock` beside the existing summarizer log, with
identical TTL semantics. `acquireLock`/`releaseLock`/`isSessionLocked` change
only their path constant; the spawn command's trap-based release follows.

## Per-device path inventory

One child node per (device, path) under the project root:

- `kind: "project-path"`, `metadata: { device, path, last_seen_at }`.
- Upserted opportunistically at session start for the current device — its own
  row, so concurrent sessions on different devices touch different rows and
  row-level LWW merges both.
- Consumed by `tim doctor` (list paths per device, flag entries with
  `last_seen_at` older than a threshold) and available to future
  cross-device navigation. **Never consulted during project resolution.**
- The service-owned canonical `metadata.path` on the root node (2026-07-16
  design) is unchanged; the inventory complements it with observed locations.
- Ephemeral environments pollute the inventory by design pressure; mitigate by
  skipping the upsert when cwd sits under a recognized throwaway root (same
  unsafe-dir spirit) and by doctor's staleness flagging. No automatic deletion.

## hmem import: binding markers for imported projects

The hmem importer (`tim-migrate/src/import.ts`) carries no filesystem
information of its own — it marks P-prefix roots as `kind=project` and copies
source metadata through. An imported project is therefore database-only until
someone binds a directory by hand, which recreates exactly the unbound-project
failure mode the 2026-07-16 design closed for creation.

The mechanism is deliberately simple: the migration is agent-driven (runbook
plus `tim-hmem-import-audit` skill), so binding becomes an **agent
obligation**, not a new subsystem. The runbook and the audit skill gain a
mandatory closing step:

> For every imported project, establish a directory binding before declaring
> the migration done. Never hand-write a `.tim-project` file — always use
> `tim bind-project --label <label> --cwd <dir>`.

Per project, the agent:

1. Takes the root node's `metadata.path` as the default answer when present
   (carried over from the hmem source or backfilled later) and the directory
   exists on this device.
2. Otherwise asks the user for the project directory — the case no
   programmatic pass can solve — or records, with the user's confirmation,
   that the project is intentionally memory-only.
3. Runs `tim bind-project`, which owns all safety: label validation against
   the store, unsafe-dir refusal, the v3 exclusive no-clobber writer (an
   existing marker with a different label is a reported conflict, never
   overwritten), backfilling `metadata.path`, and upserting the current
   device's `project-path` inventory row.

The importer itself stays filesystem-free. `tim migrate-from-hmem` ends by
listing every imported `kind=project` entry with its binding state on this
device (`bound` / `unbound` / `no-path`), so the agent's checklist — and the
handoff summary to the user — falls out of the report instead of a separate
command. The step is idempotent because `tim bind-project` is: re-running on
a bound directory with the same label is a no-op.

## Ongoing binding health: doctor detects, curate repairs

Binding drift is not migration-specific — directories move, clones appear,
projects get created on other devices. Detection and repair get permanent
homes, split the same way as the migration step (mechanical check in the
tool, judgment in the skill):

- **`tim doctor`** gains a binding section. For every `kind=project` entry
  with `metadata.path`: `unbound` (directory exists on this device, no local
  marker), `label-mismatch` (marker at that path names a different project),
  or `path-missing` (directory absent here — informational, expected on
  synced stores). The default run only reports; it never writes markers. The
  same section lists stale `project-path` inventory rows for this device.
- **`tim doctor --bind`** (opt-in) closes exactly the mechanical case: every
  `unbound` finding — directory exists locally, no local marker, label
  resolves in the store — is bound through the same code path as
  `tim bind-project`, including the no-clobber writer and the inventory
  upsert. `label-mismatch`, `no-path`, and `path-missing` are never touched;
  they stay report-only regardless of flags. Without the flag, doctor
  remains strictly read-only, because every runbook and skill wires it in as
  a harmless preflight check.
- **`tim-project-curate`** gains a fix-order entry: a doctor `unbound` or
  `label-mismatch` finding → confirm the directory with the user, then
  `tim bind-project --label <label> --cwd <dir>`; never hand-write the file,
  never overwrite a mismatched marker without explicit user decision. Since
  the skill already opens and closes with `tim_doctor`, the loop closes
  without new workflow steps.
- **Session-start hooks stay out of it.** They already self-heal the cwd
  binding; a cross-project sweep inside a tight-timeout hook would reopen
  the cross-binding bug class that cwd-only discovery closed.

## Migration

- No one-shot migration. v1/v2 files keep working read-only forever; they
  shrink to v3 on their next legitimate write.
- `rotateMarkerSession` and `reconcileMarker` are deleted with their call
  sites (`tim-session-start.sh` rotation block, summarizer gate). PITFALLS-46
  (stale cron session ids in the marker) is resolved by construction — the
  marker no longer stores a session id.
- Existing `.tim-project.lock` files are ignored after the path constant
  changes; TTL would have expired them anyway.

## Tests

- v1/v2 markers read as v3: label preserved, runtime fields ignored, corrupt
  and pattern-invalid files rejected exactly as today.
- Session start with an existing valid marker performs no marker write;
  auto-bind still creates a v3 marker; `:memory:` stores still skip writes.
- Summarizer gate reaches the same spawn/skip decisions from DB-derived
  counters that the reconcile path produced, including the batch-full
  override and lock contention (`.tim/summarizer.lock`).
- Stop hook resolves the session from the payload; without a payload session,
  `resolveCurrentSession` finds the latest session for (project, cwd) and
  returns null cleanly when none exists.
- Two devices upsert `project-path` rows concurrently and a sync round
  retains both; re-upserting the same device updates `last_seen_at` without
  duplicating rows.
- Doctor output lists the inventory and flags stale paths; resolution paths
  provably never read `project-path` nodes.
- P9999 gate, unsafe-dir refusal, and corrupt-shadowing behavior all hold on
  the v3 schema.
- Migration report: `tim migrate-from-hmem` lists each imported project with
  its binding state (`bound` / `unbound` / `no-path`) from matching fixtures.
- `tim bind-project`: same-label rebind is a no-op, different-label conflict
  leaves the existing marker byte-identical and reports both labels, a
  successful bind writes the v3 marker, backfills `metadata.path`, and
  creates the device's `project-path` inventory row.
- Runbook and audit skill contain the mandatory binding step and the
  prohibition on hand-written marker files.
- Doctor binding section: `unbound`, `label-mismatch`, and `path-missing`
  findings from matching fixtures; the default run performs no filesystem
  writes; the curate skill's fix order references the findings and
  `tim bind-project`.
- `tim doctor --bind`: binds every `unbound` fixture and reports it as
  bound on the next run; leaves `label-mismatch`, `no-path`, and
  `path-missing` fixtures untouched; a marker appearing between detection
  and write is not clobbered.

## Acceptance Criteria

- `.tim-project` on disk contains nothing but the schema version and a
  project label; nothing rewrites it during normal session traffic.
- Summarizer cadence and checkpoint reminders behave identically, sourced
  from `deriveCounters` alone.
- `rotateMarkerSession`, `reconcileMarker`, and the marker counter fields no
  longer exist in the codebase.
- The path inventory syncs without losing writes across devices and is
  demonstrably absent from every resolution code path.
- A migration is not complete until every imported project is bound, declared
  memory-only, or listed unbound in the handoff summary; the agent gets there
  through `tim bind-project` alone, and no existing marker is ever
  overwritten by migration.
- `tim doctor` without flags never writes to the filesystem; with `--bind`
  it closes only `unbound` findings, through the shared `bind-project` code
  path.
- All existing marker-protection regression tests pass unchanged in intent.
