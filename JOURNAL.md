# Fix: .tim-project overwrite bug

Date: 2026-06-03

## Root Cause

`packages/tim-hooks/src/checkpoint.ts:runSessionStart` calls `writeMarker(params.cwd, {...})` with only 5 fields (`project`, `session`, `exchanges`, `batch_size`, `batches_summarized`). `writeMarker` unconditionally overwrote the entire file, nuking global-only fields (`sessions` map, `route_exchanges_to`) from `~/.tim-project` on every session start.

Additionally, `tim-session-start.sh` always passed `--project` to `hook session-start`, forcing a project override even when the project was correctly inferred from an existing `.tim-project` marker walk-up.

## Changes

### 1. `packages/tim-hooks/src/marker.ts` — `writeMarker` merge behavior

`writeMarker` now reads any existing marker and merges the incoming fields on top. Global fields like `sessions` and `route_exchanges_to` survive every write, regardless of which caller initiated the write.

```typescript
export function writeMarker(cwd: string, marker: ProjectMarker): void {
  const p = markerPath(cwd);
  const existing = readMarker(cwd);
  const merged: ProjectMarker = existing ? { ...existing, ...marker } : marker;
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
}
```

### 2. `reconcileMarker` — already correct

`reconcileMarker` already did spread+write. With the new merge `writeMarker`, it's doubly safe against accidental field loss.

### 3. `packages/tim-hooks/scripts/tim-session-start.sh` — `--project` guard

When `$project` was resolved from a local `.tim-project` marker walk-up (`$local_marker` is set), `--project` is no longer passed to `hook session-start`. `runSessionStart` then does its own walk-up and respects whatever is in the marker file. Only when the project came from the TIM session DB (no local marker) do we pass `--project`.

### 4. `~/.tim-project` — project set to P0062

Verified current state: `~/.tim-project` project field is `"P0062"` with `route_exchanges_to: "P0062"` and a `sessions` map intact. The merge fix ensures this stays stable across future session starts.

## Verification

- 276/276 tests passing (34 test files)
- `marker.test.ts`: 14/14 passing
- `hooks.test.ts`: 10/10 passing
- Manual: `~/.tim-project` retains `sessions` and `route_exchanges_to` fields
