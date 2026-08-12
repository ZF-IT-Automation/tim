# Feature Spec — Idle sweep in the MCP server, a checkpoint that summarizes, and a re-pass that stops losing the early turns

Grilled 2026-08-12, all open points decided, no UNKNOWNs left.

## Goal

A session gets summarized because it went quiet, not because a particular harness fired a
particular hook. Any running TIM MCP server periodically looks for sessions that have
unsummarized exchanges and have been idle for a while, and spawns the summarizer for them
with an explicit session id. Codex and OpenCode sessions — which today have no session-end
signal at all — get summaries; Claude and Cursor keep their hooks and gain a net below them
for the cases no hook covers (terminal closed, worker killed, harness crashed).

Two changes ship alongside it. `tim checkpoint` spawns the summarizer itself, so the
`/tim-handoff` flow covers every harness immediately without waiting for a timer tick. And
re-summarizing a partially covered batch re-reads the whole batch, so the summary that
overwrites the old one really covers the range it claims — without that, a sweep firing
mid-batch silently drops the early turns.

## Why / context

`/clear` cannot be observed. Measured on the live DB: of 1 164 logged user exchanges, 0 begin
with a slash and 0 are `/clear` — the command produces no assistant turn, so the Stop hook
that writes exchanges never fires for it, and nothing about it reaches TIM. Polling the DB
for `/clear` is therefore impossible; polling it for *silence* is not.

Measured coverage since 2026-07-01, sessions with a rollup: `claude` 207/208, `codex` 12/17,
`Codex` 1/18, `cursor` 4/7, `default` 0/11, `cli` 0/3, `unknown` 0/4. The gap tracks exactly
what is wired: Codex has only a turn-end `notify` program (`codex-notify.ts:9` — its hook
surface has no turn-end event and is skipped entirely without persisted trust), and OpenCode
has only a `session.created` plugin plus MCP.

## Acceptance criteria

**A. Non-lossy re-pass** (`packages/tim-store/src/session.ts`, `showUnsummarized`)

1. When a batch already has a summary whose `seq_to` is below the batch's highest user `seq`,
   `showUnsummarized` returns **every** exchange of that batch (`seqFloor = 0`), not only the
   uncovered tail.
2. `previousSummaries` excludes the summary of the batch being returned
   (`batch_index === batchIndex`), so the model is never handed its own partial draft of the
   same material as "what came before".
3. After a re-pass, the batch summary node's `seq_from`/`seq_to` describe a range the content
   actually covers: re-summarizing a batch first summarized at seq 1–2 and later extended to
   seq 5 produces content derived from all five exchanges.
4. Behaviour is unchanged for a batch that has no summary yet, and for a batch whose summary
   already covers its highest seq (still skipped, no re-spawn loop).

**B. Idle sweep** (`packages/tim-hooks/src/session-hooks.ts` + `packages/tim-mcp/src/server.ts`)

5. A timer in the MCP server runs every `interval_minutes` (default 5) and spawns the
   summarizer for each session that has pending exchanges and whose newest exchange is older
   than `idle_minutes` (default 15). A quiet session is therefore picked up at most 20 minutes
   after its last turn.
6. The sweep considers **all** sessions in the database regardless of age or project — not
   only those of the server's own binding, and with no lookback cut-off. A Codex session in a
   directory nobody opens again is summarized by whatever server happens to be running.
7. The sweep always passes `sessionId` explicitly to `maybeSpawnSummarizer`, never letting it
   fall through to `resolveCurrentSession` — that path picks by cwd and `createdAt DESC` and
   hands back the wrong session when two run in one directory (recorded bug, 2026-08-10).
8. The sweep uses each session's own `metadata.cwd` as the spawn cwd. A session whose cwd is
   missing, or has no `.tim-project` marker, is skipped and written to `error_log` once —
   silently vanishing sessions are the problem this feature exists to solve.
9. At most `max_spawns_per_pass` (default 3) spawns happen per tick. One pass need not drain
   the queue: the lock is per cwd (`acquireLock`, atomic via `flag: 'wx'`), so a second
   session in the same directory returns `locked` and is picked up on a later tick.
10. A session whose spawn produced no new summary is retried at most 3 times; after that the
    sweep skips it and writes one `error_log` entry. The counter lives in `session.metadata`
    and resets as soon as a summary is written for that session again. Hook-driven paths
    (session end, checkpoint) are never blocked by this counter.
11. The timer runs in both stdio and HTTP mode. No timer is started when `isSummarizerChild()`
    is true, so the summarizer's own children never sweep.
12. `summarizer.idle_sweep.enabled: false` in `~/.tim/config.json` disables the timer
    entirely; absent config means enabled with the defaults above.
13. The sweep never writes a checkpoint, never touches the handoff note, and never triggers
    the project summary. Session end remains the only thing that does those.

**C. Checkpoint spawns the summarizer** (`packages/tim-cli/src/cli.ts`, `cmdCheckpoint`)

14. `tim checkpoint --session <id> [--handoff-note …]` spawns the summarizer for that session
    after `runCheckpoint` has returned, via `maybeSpawnSummarizer(store, cwd, { batchFull:
    true, sessionId })`. The `/tim-handoff` flow therefore summarizes under every harness,
    with no change to the skill text and without waiting for a sweep tick.
15. The spawn happens strictly **after** the checkpoint write. `updateSessionSummary`
    (`session.ts:965-975`) is a read-modify-write over the summary root's metadata: spawning
    first would let the rollup overtake a handoff note written moments later and drop it.
    A test asserts the note survives a checkpoint followed by a rollup.

## Scope

- Repo: `~/projects/tim`
- Entry points: `packages/tim-store/src/session.ts` (`showUnsummarized`, ~540-608),
  `packages/tim-hooks/src/session-hooks.ts` (new `sweepIdleSessions` beside
  `maybeSpawnSummarizer`), `packages/tim-mcp/src/server.ts` (timer start/stop beside
  `getSessions()`), `packages/tim-cli/src/cli.ts` (`cmdCheckpoint`, ~897-919),
  `packages/tim-core/src/config.ts` (new config block).
- TIM task: `ubun-0812-ns-01KZV18TGGKJXBX0P92B6RKC1K` (P0063/Tasks).

## Non-goals

- Detecting `/clear` itself. It is not observable; this spec replaces that idea rather than
  implementing it.
- A `tim sweep` CLI command or a cron entry. Decided against: the MCP server is the only host.
- Removing or changing the existing Claude `SessionEnd` and Cursor `sessionEnd` hooks, or
  adding instructions to the `/tim-handoff` skill. The skill stays as it is — criterion 14
  puts the behaviour in code instead, where it does not depend on an agent reading a sentence.
- Backfilling old sessions as a project. The unbounded sweep will pick up today's 13 pending
  sessions as a side effect; the 45 sessions deliberately left without a rollup on 2026-08-11
  have no pending exchanges and are not touched.
- The two side findings surfaced during the investigation, both still open: the TIM MCP's
  `TIM_DB_PATH` in `~/.config/opencode/opencode.json` points at a scratchpad `smoke.db`, and
  Codex registers under two agent names (`codex`, `Codex`) of which the capitalised one is
  almost entirely unsummarized.
- The summarizer chain composition (settled 2026-08-12: deepseek → codex → nemotron).

## Verification

Every criterion gets at least one test; the summarizer is stubbed through the existing `spawn`
seam and a fake summarize function, so no test calls an LLM.

- **C1, C2, C4** — `tim-store` suite: session with batch_size 5, batch summary covering seq
  1–2, exchanges 3–5 logged, then assert `showUnsummarized` returns 5 exchanges with
  `seqFrom` 1 and that `previousSummaries` does not contain the partial summary's body.
  Separate cases for an untouched batch and a fully covered batch.
- **C3** — end to end through `writeBatchSummary` with a fake summarizer echoing the seqs it
  received: after the re-pass the content mentions seq 1 and 2, and `seq_from`/`seq_to` are 1/5.
- **C5, C6, C7, C8** — sweep unit test with a stub spawner: one idle session, one fresh, one
  in a marker-less cwd, one whose cwd does not exist. Assert exactly one spawn, carrying the
  idle session's id and that session's cwd, and two `error_log` entries.
- **C9** — six eligible sessions in six cwds produce three spawns in one pass; two eligible
  sessions in the same cwd produce one spawn and one `locked`, and a second pass spawns the
  other after the lock is released.
- **C10** — a session whose spawn writes no summary is retried 3 times and then skipped, with
  one `error_log` entry; writing a summary resets the counter and it becomes eligible again.
- **C11, C12** — no timer with `TIM_SUMMARIZER=1`, no timer with `idle_sweep.enabled: false`,
  timer present in both stdio and HTTP construction paths.
- **C13** — after a sweep spawn: no new `checkpoint` child, `metadata.handoff_note` unchanged,
  no project summary write.
- **C14, C15** — `tim checkpoint` spawns exactly once with `batchFull: true` and the given
  session id, and the spawn is ordered after the checkpoint write: a handoff note written by
  the checkpoint survives a subsequent `updateSessionSummary`.

Plus the existing suite stays green (1 721 passed / 2 skipped at `5d115f6`).

## Interfaces & data

```ts
// tim-hooks/src/session-hooks.ts
export interface IdleSweepOptions {
  idleMinutes?: number;        // default 15
  maxSpawnsPerPass?: number;   // default 3
  maxAttempts?: number;        // default 3
  spawn?: Spawner;             // test seam
  now?: () => number;          // test seam
}
export async function sweepIdleSessions(
  store: TimStore,
  opts?: IdleSweepOptions,
): Promise<Array<{ sessionId: string; reason: SessionStopResult['reason'] | 'no-cwd' | 'exhausted' }>>;
```

```jsonc
// ~/.tim/config.json
"summarizer": {
  "idle_sweep": {
    "enabled": true,
    "interval_minutes": 5,
    "idle_minutes": 15,
    "max_spawns_per_pass": 3
  }
}
```

Session metadata gains `sweep_attempts: number` (absent = 0), reset when the session's
`batchesSummarized` increases.

## Measurements behind the decisions

- Scan cost, live DB (389 session nodes, 10 123 entries): listing 7 ms, `deriveCounters` over
  all 389 sessions 223 ms. No store-level query is needed — `deriveCounters` per session is
  cheap enough for a 5-minute tick, which is why criterion 6 can afford an unbounded sweep.
- Backlog at first run: 13 sessions with pending exchanges (12 aged 1–7 days, 1 older than 30
  days, 6 with ≤2 pending), all with existing cwds and markers. At 3 spawns per tick that
  drains in about 20 minutes.
- Retry pressure is bounded by design: `LOCK_TTL_MS` (720 s) exceeds the summarizer timeout
  (600 s), so a stuck run is never overtaken — retries serialize to roughly one per 12 minutes
  even before criterion 10 caps them.

## Findings that shaped this spec

- `writeBatchSummarySync` (`session.ts:676-708`) upserts by `batch_index`: it **replaces**
  `content` and merges the seq range to `min(from)`/`max(to)`. That is why criterion 1 is
  necessary — without it, a tail-only summary inherits a range claiming the whole batch and
  the early turns are silently gone.
- `runSummarizerLoop` (`summarize.ts:294-325`) breaks on `!batch.hasMore`, and `hasMore`
  (`session.ts:587-593`) only inspects batches with a *higher* index. A partially covered
  final batch is therefore not re-visited within the same summarizer run; the re-pass happens
  on the next invocation. Ordering matters: part A must ship with or before part B, never after.
- A failing model or a missing chain cannot strand a session: when every CLI fails,
  `generateSummaryDetailed` (`generate-summary.ts:519-527`) returns a heuristic summary and the
  loop writes it, so pending drops. Only three process-level faults leave pending untouched —
  the summarizer process dying before its write (timeout kill, OOM, reboot), `connectTimMcp()`
  failing, and a broken session subtree. Measured frequency: 1 timeout in the global
  `summarizer.log`, 0 in the project log. Criterion 10 defends a rare case, not a common one.
