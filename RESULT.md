## Result: .tim-project overwrite bug — FIXED

### Problem
`runSessionStart` overwrote `~/.tim-project` with only 5 fields on every session start, destroying the `sessions` map and `route_exchanges_to`.

### Fix
1. **`writeMarker`** — now merges instead of overwrites. Existing fields survive.
2. **`reconcileMarker`** — already correct, doubly safe with merge writeMarker.
3. **`tim-session-start.sh`** — no longer passes `--project` when project was inferred from local `.tim-project` walk-up.

### Test Results
```
Test Files  34 passed (34)
     Tests  276 passed (276)
  Duration  2.96s
```

### Files Changed
- `packages/tim-hooks/src/marker.ts` — `writeMarker` merge logic
- `packages/tim-hooks/scripts/tim-session-start.sh` — `--project` guard
