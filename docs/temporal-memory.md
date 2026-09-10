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

## Limitations

- Supersession chains are bounded to depth 32 for cycle detection.
- Temporal SQL filters use lexicographic ISO comparison — normalize offsets when
  mixing `Z` and explicit offsets in one project.
- `asOf` applies to search eligibility, not to automatic rewriting of entry
  bodies on read.
