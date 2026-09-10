# Memory health diagnostics (#37)

Doctor and `tim_health` report whether conversations were logged, summarized, and embedded — not only whether the database is reachable.

## Where it appears

| Surface | Field |
|---------|-------|
| `store.health()` / MCP `tim_health` | `memory` (structured JSON) |
| CLI `tim doctor` / MCP `tim_doctor` | Human-readable lines via `formatMemoryHealthLines` |

All surfaces call the same `computeMemoryHealth(store)` helper. Health reads are **read-only**: no model initialization, no summary generation, no sync requests, no store writes.

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
| `observedExchangeCount` | User exchanges in session trees |
| `coveredExchangeCount` | Observed minus pending |
| `pendingExchangeCount` | Exchanges outside a valid batch-summary `seq_from`/`seq_to` |
| `sessionsWithPending` | Sessions with at least one pending exchange |
| `pendingRanges` | Compact inclusive seq ranges (max 50 samples) |
| `coveredRanges` | Valid summary ranges (max 50 samples) |
| `latestBatchSummary` | Most recent batch-summary ref (no body text) |
| `latestRollup` | Most recent session-summary-root with rollup metadata (no body text) |

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

Counts: `vectorCount`, `unembeddedCount`, `staleVectorCount`, `wrongModelCount`. Absence of vectors is **not** reported as success when the provider is `enabled`.

### `sync`

Local filesystem telemetry only — health does **not** probe the sync server.

| `telemetryState` | Meaning |
|------------------|---------|
| `not_configured` | No `~/.tim/sync.json` |
| `configured_no_state` | Config present, no `sync-state.json` |
| `available` | `lastPush` / `lastPull` from `sync-state.json` |

`unackedStaging` counts rows from the local staging table.

## Actionable guidance

`guidance` is an ordered string list for operators. Examples:

- Pending summarization → inspect idle sweep / `showUnsummarized`
- Invalid summary range → resummarize; do not fabricate bounds
- Embedding backlog when enabled → wait for background hook or inspect provider
- Provider `disabled` / `unavailable` / `unknown` → see `docs/semantic-retrieval.md`
- Sync not configured or unacked staging → see `tim sync status`

## Severity interaction

Existing `status` / `blockers` / `warnings` semantics are unchanged. Memory findings add **warnings** when:

- `pendingExchangeCount > 0`
- Embedding provider is `enabled` and vector backlog > 0

They do not upgrade to `BLOCKER` on their own.

## Limits

- Range samples capped at 50 per pending/covered list.
- No secret or suppressed entry titles/bodies in output.
- No temporal-validity claims (#36) — sequence coverage only records which exchanges a summary claims to cover.
