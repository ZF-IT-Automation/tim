# Memory health diagnostics (#37)

Doctor and `tim_health` report whether conversations were logged and summarized — not only whether the database is reachable.

## Where it appears

| Surface | Field |
|---------|-------|
| `store.health()` / MCP `tim_health` | `memory` (structured JSON) |
| CLI `tim doctor` / MCP `tim_doctor` | Human-readable lines via `formatMemoryHealthLines` |

All surfaces call the same `computeMemoryHealth(store)` helper. Health reads are **read-only**: no model initialization, no summary generation, no sync requests, no store writes.

Opening a legacy database through `TimStore` may still run constructor migrations or FTS integrity checks — those are outside `computeMemoryHealth` and are not universally read-only.

## Additive schema (`HealthReport.memory`)

```typescript
interface MemoryHealthReport {
  summaryCoverage: MemorySummaryCoverageReport;
  sync: MemorySyncTelemetryReport;
  guidance: string[];
}
```

### `summaryCoverage`

| Field | Meaning |
|-------|---------|
| `workState` | `no_sessions` \| `no_exchanges` \| `fully_covered` \| `pending` \| `unknown` |
| `observedExchangeCount` | User exchanges in batched and flat/unbound session trees |
| `coveredExchangeCount` | Observed minus pending |
| `pendingExchangeCount` | Exchanges outside a valid summary interval |
| `unknownSequenceExchangeCount` | Exchanges with missing/invalid positive integer `seq` metadata |
| `sessionsWithPending` | Sessions with at least one pending exchange |
| `pendingRanges` / `coveredRanges` | Compact inclusive seq range samples (max 50 each) |
| `pendingRangeCount` / `coveredRangeCount` | Total ranges before sampling |
| `pendingRangesTruncated` / `coveredRangesTruncated` | True when totals exceed the sample cap |
| `latestBatchSummary` | Globally latest **successful** batch-summary ref (non-empty body; no placeholder) |
| `latestRollup` | Globally latest session-summary-root with non-empty rollup metadata |

**Flat/unbound sessions:** `sessionStart` + `sessionLog` exchanges count as observed. Checkpoint or rollup evidence with valid session sequence sources may establish coverage; otherwise exchanges stay pending. They are never reported as absent.

**Partial sessions:** A batch summary does not imply full coverage. Exchanges logged after a partial summary remain `pending` even when a summary node exists.

**Legacy ranges:** Missing, nonnumeric, or reversed `seq_from`/`seq_to` do **not** establish coverage (`rangeKnown: false`). Associated exchanges stay pending.

### `sync`

Local filesystem telemetry only — health does **not** probe the sync server.

| `telemetryState` | Meaning |
|------------------|---------|
| `not_configured` | No `~/.tim/sync.json` |
| `disconnected` | Placeholder config: `serverUrl`, `userId`, `token`, `salt`, and `fileId` are all empty strings. Not invalid JSON and not a network failure |
| `invalid_config` | JSON parsed, but connection fields are missing, mistyped, or only partly filled |
| `invalid_json` | `sync.json` or `sync-state.json` is not valid JSON |
| `invalid_timestamp` | A push/pull timestamp or attempt timestamp is present and not a timezone-qualified ISO string. History is ignored |
| `configured_no_state` | Valid config, no `sync-state.json` |
| `unbound` | State file is legacy: it lacks database, server, tenant, or protocol-generation binding. Cursor and success timestamps are not evidence |
| `available` | State is bound to this database, server, tenant, file, and protocol generation. `lastPush` / `lastPull` are last successful delivery, null or valid ISO |
| `mismatched_file` | State `fileId` differs from configured `sync.json` — cursor and timestamps ignored |
| `mismatched_db` | State is bound to a different database path — cursor ignored |
| `mismatched_server` | State is bound to a different server URL — cursor ignored |
| `mismatched_tenant` | State is bound to a different tenant — cursor ignored |
| `mismatched_protocol` | State protocol generation differs from this client — cursor ignored |

`lastPush` / `lastPull` are successful delivery only, and only when `telemetryState` is `available`. `lastPushAttempt` / `lastPullAttempt` and `lastPushError` / `lastPullError` record the latest cycle, including failures that must not move the success timestamps. They are historical local evidence, not current server reachability. `cursorUsable` is true only for a bound match. `unackedStaging` counts unacked staging rows without loading payload bodies.

`tim sync audit --json` is the read-only gate report: effective staging trigger, backlog count and oldest age, queue bytes, attempt/success/error, and connection identity. It does not include the token or salt. `tim sync repair` archives a mismatched or legacy state file and writes a new bound state with a null cursor. Diagnosis does not reset state, and repair does not reuse the archived cursor.

## Actionable guidance

`guidance` is an ordered string list for operators. Examples:

- Pending summarization → inspect idle sweep / `showUnsummarized`
- Invalid summary range → resummarize; do not fabricate bounds
- Sync disconnected, invalid config/JSON/timestamps, unbound or mismatched identity, or unacked staging → see `tim sync audit --json`

## Severity interaction

Existing `status` / `blockers` / `warnings` semantics are unchanged. Memory findings add **warnings** when:

- `pendingExchangeCount > 0`

They do not upgrade to `BLOCKER` on their own.

## Limits

- Range samples capped at 50 per pending/covered list; totals and truncation flags are always reported.
- Latest batch summary / rollup selection is global (not limited to the newest 200 summary roots by `created_at`).
- No secret or suppressed entry titles/bodies in output.
- No temporal-validity claims (#36) — sequence coverage only records which exchanges a summary claims to cover.
