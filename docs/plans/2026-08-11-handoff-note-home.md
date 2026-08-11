# Feature Spec — Handoff note gets its own home; checkpoints become disposable

Status: grilled 2026-08-11, all open points decided. Build order: merge
`17c6699` first, then this spec, then `2026-08-11-topic-recall.md`.

## Goal

The handoff note a session writes for the next one must stop living in the
metadata of a node whose entire purpose is to be thrown away. It moves to the
session's Summary root (`metadata.handoff_note`), written at handoff time with
the same read-back verification the checkpoint write has today. Once the note no
longer depends on them, checkpoint nodes whose content the summarizer has
already superseded are deleted. The four structural tags nothing reads are
retired in the same pass.

## Why / context

Two checkpoints were written for a three-turn session (a manual `/tim-handoff`
and the session-end hook), both carrying heuristic text that the batch summary
replaced 19 seconds later. Only one thing in them is irreplaceable: the
`handoff_note`, whose sole reader is `session-briefing.ts:83`. `resumeSession`
never sees it at all, so `/tim-resume` silently drops the most valuable text of
the previous session.

## Acceptance criteria

1. `SessionManager.checkpoint(sessionId, { handoffNote })` writes the note into
   the session's Summary root as `metadata.handoff_note`, replacing any previous
   value there. One slot per session, always the newest.
2. The note is written **only** to the Summary root. No dual-write, no copy left
   on the checkpoint node — DECIDED, do not re-open.
3. That write is verified the way the checkpoint node's write is verified today
   (`session.ts:884-892`): read back, and throw if the value did not persist. A
   handoff note that silently fails to save is the worst failure mode this
   feature has.
4. The note is written at handoff time. It must not depend on the summarizer,
   which is spawned best-effort and may never run.
5. `resumeSession` returns the note: `ResumePayload.handoffNote?: string`, read
   from the Summary root it already loads (`session.ts:1033`).
6. A checkpoint node is reapable when `metadata.kind === 'checkpoint'` and the
   session's Summary root has a non-empty `metadata.summary` (i.e. the
   summarizer's rollup exists). Reaping deletes the node and its `summarizes`
   edge.
7. Reaping runs as a sweep, folded into the session-skeleton reaper already
   queued as P0063 item 21 — one reaper, one predicate more. It does **not** run
   inside the summarizer path; a best-effort process must not be a deleter.
8. Existing checkpoint nodes (~245) are deleted by the same sweep. Their
   `handoff_note` values are **not** migrated — DECIDED 2026-08-11: the old notes
   are data waste. A `~/.tim/tim.db.bak-pre-checkpoint-reap` backup is taken
   before the first destructive run.
9. `#exchange`, `#session`, `#sessions`, `#exchanges` and `#checkpoint` are
   removed from the write sites that emit them (`session.ts:341`, `:425`,
   `:435`, `:879`, and the session/exchanges-root writers), so nothing stamps
   them automatically any more. AMENDED 2026-08-11: they are **not** added to
   `DEPRECATED_TAGS`. Banning the words would have cost this project four of the
   terms it is most about — a summary of the work on checkpoint reaping must be
   able to carry `#checkpoint`, and the follow-up spec's whole value is
   tag-driven recall over exactly that vocabulary. The structural meaning lives
   in `metadata.kind` and never needed a tag. They live in
   `RETIRED_STRUCTURAL_TAGS`, which drives criterion 11's cleanup and nothing
   else; `stripDeprecatedTags` does not touch them.
10. `#session-summary`, `#batch-summary` and `#commit` are **kept**.
    `summarize.ts:64/73`, `project-output.ts:549/556` and `server.ts:1534` read
    the first two; `#commit` becomes useful the moment tag-only retrieval lands
    in the follow-up spec.
11. Existing rows carrying the retired tags are cleaned through the migration
    mechanism (explicit opt-in gate, `c56696d`) — `tim migrate
    retire-deprecated-tags` — not by ad-hoc SQL, which would bypass staging and
    LWW and would be undone by the next write anyway. This touches thousands of
    rows (`#exchange` alone is on 2262): take
    `~/.tim/tim.db.bak-pre-tag-retirement` before the run, same discipline as
    criterion 8. The sweep is **one-time and order-dependent**: it cannot tell a
    deliberate `#checkpoint` from one the old write sites left behind, so it runs
    before anyone tags an entry with those words on purpose.

## Scope

- Repo: `~/projects/tim`
- Entry points: `packages/tim-store/src/session.ts` (`checkpoint`,
  `resumeSession`, tag write sites), `packages/tim-core/src/types.ts`
  (`DEPRECATED_TAGS`), `packages/tim-mcp/src/server.ts` (resume payload),
  the session-skeleton reaper (P0063 item 21)
- TIM task: P0063/Tasks

## Non-goals

- Do **not** stop writing the checkpoint node at session end. The summarizer is
  spawned asynchronously and best-effort (`checkpoint.ts:363`); the checkpoint is
  the crash guarantee. Write first, reap later is the honest order.
- Do **not** touch the session-start briefing. Every briefing change belongs to
  `2026-08-11-topic-recall.md`, including the reader that renders the note today
  (`session-briefing.ts:83-85`, `:186`) — that block is being deleted there, so
  rewiring it here would build code the next spec removes.
- Do not make handoff notes full-text searchable. Explicitly decided against.
- No new node kind, no new tree level, no change to the note's content or format.
- No direct SQL against `~/.tim/tim.db`.

## Verification

- `checkpoint()` with a note: Summary root carries it; a second checkpoint with a
  new note replaces it rather than appending; the checkpoint node carries none.
- Verification failure path: a store whose read-back returns no note makes
  `checkpoint()` throw.
- `resumeSession` payload carries the note for a session that has one, and omits
  the field for one that does not.
- Reaper: a session with a rollup loses its checkpoints; a session without one
  keeps them; no `summarizes` edge is left dangling.
- Tag retirement: a fresh session writes no `#exchange`/`#session`/`#exchanges`/
  `#checkpoint`; a write that passes them explicitly has them stripped;
  `#session-summary`, `#batch-summary` and `#commit` survive untouched.
- Full suite under the standing check:
  `mv tmp /tmp/tim-tmp-parked && env HOME=$(mktemp -d) npx vitest run`

## Interfaces & data

- `SessionManager.checkpoint(sessionId, opts)` — unchanged signature, note now
  lands on the Summary root.
- `ResumePayload.handoffNote?: string` — new optional field.
- `SessionManager.reapCoveredCheckpoints(sessionId?): Promise<number>` — called
  by the item-21 sweep.
- `DEPRECATED_TAGS` gains four entries.

## Known related defects (do not fix here, do not be surprised by)

- `tim_update` merges metadata rather than replacing it, so no MCP path can
  *unset* a key. Overwriting a note with a new value works; clearing one does not.
- The comment at `session-briefing.ts:77` claims checkpoints carry no
  `metadata.order`. They do — `store.write` assigns it (`store.ts:2172-2174`).
  Do not build ordering logic on that comment.
