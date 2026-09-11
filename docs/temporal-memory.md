# Temporal memory validity

TIM supports explicit validity intervals and supersession for memory entries.
Historical bodies and evidence remain stored; current retrieval favors valid
knowledge while optional `asOf` search reconstructs earlier states.

## Shape

```json
{
  "temporal": {
    "validFrom": "2026-01-01T00:00:00Z",
    "validUntil": "2026-06-01T00:00:00Z"
  }
}
```

- Intervals are **half-open**: `[validFrom, validUntil)`.
- Timestamps must be timezone-qualified ISO 8601 strings (`Z` or `±hh:mm`).
- Entries **without** `metadata.temporal` are legacy current records.

System-managed fields (`supersededAt`, `supersededBy`) are set only by the
validated `tim_link` operation with `type: "supersedes"`. Direct writes,
updates, and `tim_write_many` reject forged supersession metadata.

## Supersession

Use `tim_link` with:

- `type`: `"supersedes"`
- `sourceId`: the **new** replacement entry
- `targetId`: the **old** decision being replaced
- `metadata.effectiveAt`: timezone-qualified ISO timestamp

The operation is atomic: it validates same-project membership, date
compatibility, and absence of cycles (including longer chains), then creates the
edge and updates both entries. On failure nothing changes — entries, edges, and
the sync staging log stay as they were.

Semantics at `effectiveAt`:

- The target is marked superseded (`supersededAt`, `supersededBy`, `validUntil`).
- The source gains `validFrom` when not already set.
- The edge stores `priorTarget` / `priorSource` validity snapshots for safe undo.

## Undoing a mistaken supersession

Use `tim_unlink` on the `supersedes` edge. When the edge carries stored snapshots,
managed temporal fields on the target and source are restored atomically if they
still match the values introduced by that edge. Older edges without snapshots
require an explicit `targetValidity` patch (`{}` restores an unbounded target).
Legacy recovery preserves source validity because its original value is unknown.
An explicit patch is rejected when a snapshot is available. Conflicting edits,
invalid snapshots, or other supersession edges involving either endpoint cause
undo to fail without writes; resolve dependent history explicitly first.
Normal non-supersedes edges unlink as before (edge row only).

For a malformed imported edge with no matching managed state, use
`tim_unlink({"edgeId":"<edge-id>","discardUnmanaged":true})`. This explicit repair
deletes only the edge and stages its deletion; it never changes entry validity.
It refuses targets carrying managed supersession fields and cannot be combined
with `targetValidity`. Ordinary undo remains fail-closed for invalid edge metadata.

## Read projection

`tim_read` always returns the stored body and evidence. It adds a `temporal`
projection:

- `state`: `current` | `superseded` | `not_yet_valid` | `expired`
- `valid_from`, `valid_until`, `superseded_at` when recorded
- `superseded_by`, `supersedes`, and `contradictions` references
- Secret or suppressed targets appear as `unavailable`/`suppressed` without
  leaking hidden titles or bodies

Authority labels remain evidence annotations, not authentication.

## Search

Default `tim_search` excludes entries that are not yet valid, expired, or
superseded **as of now**. Temporal eligibility is applied before candidate
limits in FTS, vector, and hybrid modes.

Pass `asOf` (timezone-qualified ISO) to reconstruct which entries were valid at
that instant. Boundary behavior follows the half-open interval rules above.

## Contradictions

Explicit `contradicts` / `contradicted_by` edges are preserved. Reads expose
unresolved contradiction references; TIM does not pick a winning fact.

- Timestamps are normalized to canonical UTC on write; search eligibility compares
  instants by epoch milliseconds. Peer/import rows with unusable temporal fields
  are treated as legacy current records (matching read projection), not silently
  dropped from search.
- Tag-only `tim_search` applies the same current/`asOf` eligibility before limits.
- Impossible calendar dates, invalid clock times, unsupported sub-millisecond
  precision, and forged supersession metadata are rejected.
- Supersession cycle detection traverses the full reachable graph up to a safety
  limit (`10_000` nodes), then fails closed with an explicit error.
- Partial `metadata.temporal` patches preserve system-managed supersession fields;
  empty patches cannot revive superseded entries.
- `asOf` applies to search eligibility, not to automatic rewriting of entry
  bodies on read.
