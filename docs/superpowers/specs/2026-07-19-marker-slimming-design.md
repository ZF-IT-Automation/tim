# Slim `.tim-project` to Binding-Only; Runtime State Moves Into the Store

**Date:** 2026-07-19
**Status:** Proposed design, pending review

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

Add a post-import binding pass, run as a step of the `tim migrate-from-hmem`
wizard and available standalone as `tim bind-imported-projects [--dry-run]`:

1. Enumerate `kind=project` entries (Inbox excluded). The candidate path is
   the root node's `metadata.path` — present when the hmem source carried it
   or when it was backfilled later. There is no path guessing; a project
   without `metadata.path` is reported, never bound.
2. A candidate binds only when all of these hold on the current device: the
   path exists and is a directory, it is not an unsafe marker dir
   (`isUnsafeMarkerDir`), and it has no local `.tim-project` of its own. The
   marker is written with the v3 exclusive no-clobber writer.
3. Every project gets one report line: `bound`, `already-bound` (existing
   marker, same label), `conflict` (existing marker, different label —
   reported with both labels, resolved manually, never overwritten),
   `no-path` (no `metadata.path`), or `path-missing` (directory absent on
   this device — expected when migrating a synced store on a second machine).
4. The wizard shows the dry-run table and asks once before writing; the
   standalone command defaults to `--dry-run` semantics matching `tim import`.
5. A successful bind also upserts the current device's `project-path`
   inventory row, so migration seeds the inventory.

The pass is idempotent: re-running it finds `already-bound` everywhere it
succeeded. For `no-path` and `path-missing` projects, the migration runbook
gains a closing step directing the agent to ask the user for the directory
and run `tim bind-project --label <label> --cwd <dir>`, which also backfills
`metadata.path`. The importer itself stays filesystem-free; all binding logic
lives in the post-import pass.

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
- Binding pass: each report outcome (`bound`, `already-bound`, `conflict`,
  `no-path`, `path-missing`) is produced from a matching fixture; `conflict`
  leaves the existing marker byte-identical; dry-run writes nothing; a second
  run reports `already-bound` for everything previously bound; a successful
  bind creates the device's `project-path` inventory row.

## Acceptance Criteria

- `.tim-project` on disk contains nothing but the schema version and a
  project label; nothing rewrites it during normal session traffic.
- Summarizer cadence and checkpoint reminders behave identically, sourced
  from `deriveCounters` alone.
- `rotateMarkerSession`, `reconcileMarker`, and the marker counter fields no
  longer exist in the codebase.
- The path inventory syncs without losing writes across devices and is
  demonstrably absent from every resolution code path.
- After `tim migrate-from-hmem`, every imported project with a locally valid
  `metadata.path` has a v3 marker, and every other project appears in the
  binding report with an actionable outcome; no existing marker is ever
  overwritten by migration.
- All existing marker-protection regression tests pass unchanged in intent.
