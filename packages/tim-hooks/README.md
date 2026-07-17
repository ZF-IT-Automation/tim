# tim-hooks

Session hooks, checkpoint logic, and `.tim-project` marker handling for TIM.

## Project binding: `.tim-project` vs `tim.json`

**`.tim-project` is runtime state, not source.** It holds per-session fields (`session`, `exchanges`, `batch_size`, `batches_summarized`) that change every session. Do not commit it — it is listed in the repo `.gitignore`.

**`tim.json` is the committed canonical default.** It contains only the stable project label, e.g. `{"project": "P0063"}`. Workers and fresh clones rely on this when no local `.tim-project` exists yet.

### Resolution order

1. **Nearest `.tim-project`** (walk up from cwd) — wins when present. Corrupt files are rejected (no silent fallback to `tim.json` at the same directory).
2. **`tim.json`** (walk up) — used when no `.tim-project` exists on that chain.
3. **`~/.tim/active-project`** or Inbox (`P0000`) — see `checkpoint.ts`.

### Per-developer override

Create `.tim-project` in the repo root (or any ancestor of your cwd). Session start will refresh it. To change the team default for new clones, edit committed `tim.json` instead.

`validateMarkerAgainstStore` still rejects pattern-valid labels that do not exist in the TIM DB (defense against bogus labels like `P9999`).

## Hook CLI resolution

Hook entrypoints are relocatable. They resolve the TIM CLI in this order:

1. `TIM_CLI` override.
2. A `tim` executable on `PATH`.
3. The sibling installed package at `tim-cli/dist/cli.js`.

For example, run `bash packages/tim-hooks/scripts/tim-statusline.sh` from a source checkout, or copy/symlink the packaged scripts from any installation prefix. No repository-specific absolute path is required.
