# Memory health diagnostics (#37)

Doctor and `tim_health` report whether conversations were logged, summarized, and embedded — not only whether the database is reachable.

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
  semanticIndex: SemanticIndexHealthSnapshot;
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

### `semanticIndex`

Same contract as `store.getSemanticIndexHealth()` / `docs/semantic-retrieval.md`:

| `providerState` | Meaning |
|-----------------|---------|
| `disabled` | `TIM_EMBEDDING_DISABLED=1` |
| `unavailable` | Configured model ID unsupported |
| `unknown` | Default provider not yet initialized (health never loads models) |
| `enabled` | Injected or cached default provider ready |

Counts: `vectorCount`, `unembeddedCount`, `staleVectorCount`, `wrongModelCount`.

`unembeddedCount` is the total eligible rows needing (re)indexing — stale and wrong-model rows are subsets, not additive duplicates. Absence of vectors is **not** reported as success when the provider is `enabled`.

### `sync`

Local filesystem telemetry only — health does **not** probe the sync server.

| `telemetryState` | Meaning |
|------------------|---------|
| `not_configured` | No `~/.tim/sync.json` |
| `configured_no_state` | Valid config, no `sync-state.json` |
| `available` | State `fileId` matches config; `lastPush` / `lastPull` are null or valid ISO timestamps |
| `malformed` | Unreadable JSON or invalid timestamp shape |
| `mismatched_file` | State `fileId` differs from configured `sync.json` — timestamps ignored |

`lastPush` / `lastPull` are historical local evidence only, not current server reachability. `unackedStaging` counts unacked staging rows without loading payload bodies.

## Actionable guidance

`guidance` is an ordered string list for operators. Examples:

- Pending summarization → inspect idle sweep / `showUnsummarized`
- Invalid summary range → resummarize; do not fabricate bounds
- Embedding backlog when enabled → `unembeddedCount` total with optional stale/wrongModel breakdown
- Provider `disabled` / `unavailable` / `unknown` → see `docs/semantic-retrieval.md`
- Sync malformed / mismatched fileId / unacked staging → see `tim sync status`

## Severity interaction

Existing `status` / `blockers` / `warnings` semantics are unchanged. Memory findings add **warnings** when:

- `pendingExchangeCount > 0`
- Embedding provider is `enabled` and `unembeddedCount > 0`

They do not upgrade to `BLOCKER` on their own.

## Limits

- Range samples capped at 50 per pending/covered list; totals and truncation flags are always reported.
- Latest batch summary / rollup selection is global (not limited to the newest 200 summary roots by `created_at`).
- No secret or suppressed entry titles/bodies in output.
- No temporal-validity claims (#36) — sequence coverage only records which exchanges a summary claims to cover.
