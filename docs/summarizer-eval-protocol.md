# Summarizer test protocol

How a model earns a place in `summarizer.chain`. Every candidate runs the same frozen
inputs through the shipping prompt builders and the shipping CLI invocation (`tryCli`),
and the result is a table of numbers plus a winner picked by a rule fixed in advance.

## Run it

```bash
npm run build
cd ~   # stable cwd; codex would otherwise read the repo's AGENTS.md
node ~/projects/tim/packages/tim-summarizer/dist/eval-summarizer.js run --trials 3
```

Output: `~/.tim/bench/runs/<timestamp>/results.json` (every call, every output) and
`report.md`. Copy the table into a dated report under `docs/plans/` and record the decision in TIM.

## Inputs

Everything lives under `~/.tim/bench/`, **never in the repo**: these are real session contents.

| File | Content |
|---|---|
| `summarizer-candidates.json` | `[{label, cli, model, provider?, args?}]`, the same shape as a chain entry. A new model is one new line. |
| `summarizer-fixtures.json` | Frozen cases and their must-keep labels, plus the 20 labeled substance sessions from `__tests__/fixtures/substance-labels.json`. |

Fixtures are extracted once with `eval-summarizer.js extract [--projects P0063,P0054]`:

- 3 batches (small, medium, large), rebuilt through `SessionManager.batchExchanges`
- 3 rollups (1 batch, 2–4 batches, 5+ batches)
- 1 project summary per project, from `collectProjectSummaryInput`

After extraction, label each case by hand with 3–6 **must-keep facts**. A fact is a list of
alternative keywords, and any match counts. Label decisions, open items and identifiers the
next session needs, not trivia. Re-extracting needs `--force` and throws the labels away. Do
this only when the fixture set itself should change, and never between two runs you want
to compare.

The inputs are frozen, the prompts are not: each run builds its prompts with the current
code. `results.json` stores the commit and one hash per prompt, so two runs with different
prompt hashes were not on the same test.

## What runs

- **Control row:** the production head of `summarizer.chain` always runs as well (or is
  marked `(control)` when it is in the list). Free-tier and quota latency drifts from
  day to day, so only differences within one run are comparable.
- **Scheduling:** candidates run in parallel, so everyone sees the same load window. Within a
  candidate, cases run sequentially.
- **Repetitions:** batch, rollup and project run `--trials` times (default 3; 2 cannot separate
  models that are within a factor of 2 of each other). Substance runs once over its 20 sessions.
- **Project path:** goes through the same steps as `generateProjectSummary`: one compress pass
  if the output is too long, then `clampToWholeBullets`.
- **Timeout:** 300 s per call.

## Metrics

| Metric | How it is measured |
|---|---|
| Reliability | share of successful calls; timeouts counted separately |
| Latency | median and p90 in seconds, wall clock including CLI start |
| Tokens | median of `tokens used` from the codex output (compress pass included); `–` for CLIs that report none |
| Contract | **batch:** `SUBSTANCE` line, body ≤ `BATCH_SUMMARY_MAX_CHARS`, 1–3 subject tags, ≤ 1 activity tag from `#design #implementation #debugging #review`, no container/project/drift tag. **rollup:** 4–6 bullets, ≤ 200 words, no preamble. **project:** not empty after clamp, 2–3 bullets |
| English | output is English (`ENGLISH_SUMMARY_INSTRUCTION`); stopword heuristic |
| ID recall | share of the input's identifiers (commit hashes, labels, node ids, paths) that reach the output. Relative only: a summary may not carry everything over |
| Invented IDs | identifiers in the output that do not appear in the input. Target: 0 |
| Must-keep | share of labeled facts that are present in the output |
| Substance | none vs. not-none accuracy over the 20 labeled sessions (existing bar: ≥ 18/20) |

## Decision rule

Fixed before any run and implemented in `pickWinner`:

1. Eligible are candidates with **100 % reliability** and **100 % contract compliance**,
   whose must-keep score is **at most 5 percentage points** below the best.
2. Among these, the **cheapest** wins (median tokens), then the **fastest** (median latency).
3. No candidate eligible → the chain stays as it is, and the report says what failed.

A winner goes to the head of the chain. Whether the previous head stays behind it as a
fallback is decided separately and noted in the report.

## Scope

Measured: model × prompt on frozen inputs. Not measured: the live pipeline (hooks, idle
sweep, spawn cwd, locks). That belongs to the health check, not to model selection.
