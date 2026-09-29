# Summarizer eval: Luna 6 low / medium / high

Date: 2026-09-29 · first run of the standard protocol (`docs/summarizer-eval-protocol.md`).
Fixtures: `~/.tim/bench/summarizer-fixtures.json` (8 cases: 3 batch, 3 rollup,
2 project, plus 20 substance sessions), 3 trials per case, prompt hash `a250056c4a4d`.
All three candidates are `codex exec --model gpt-6-luna` with
`-c model_reasoning_effort=low|medium|high`. Medium is the production head (control).

## Result

Run 2 (`~/.tim/bench/runs/2026-09-29T13-04-20-940Z`, the first run with token counts):

| Candidate | Reliability | Latency med / p90 s | Tokens med | Contract | English | ID recall | Invented IDs | Must-keep | Substance |
|---|---|---|---|---|---|---|---|---|---|
| luna-low | 100 % | 6.7 / 11.4 | 1174 | 96 % | 100 % | 33 % | 0 | 85 % | 19/20 |
| luna-medium (control) | 100 % | 6.2 / 11.4 | 1178 | 96 % | 100 % | 32 % | 0 | 86 % | 19/20 |
| luna-high | 100 % | 7.6 / 19.5 | 2363 | 96 % | 100 % | 31 % | 0 | 90 % | 19/20 |

Run 1 (`…T12-56-56-330Z`, no token counts because codex writes `tokens used` to stderr; fixed
before run 2) matches it: must-keep 82 / 84 / 90 %, contract 96 / 100 / 100 %.

Tokens are the count codex reports as `tokens used`, not the raw prompt size.

**Winner by the fixed rule: none.** Every candidate has one contract break (1 of 24 scored
calls each, always a batch), so the chain stays as it is (`gpt-6-luna` medium).

## Findings

- **No difference between low and medium.** Across two runs they are equal on tokens (1174 vs. 1178),
  latency and must-keep (82–86 %).
- **High keeps +4–6 points more (90 % in both runs), at twice the tokens and a longer p90.**
  Stable across both runs only in the large batches: `batch/434546a4` high 100 % in every trial,
  `batch/7c186cd3` high ≥ the others. On rollups and project summaries the misses scatter across all
  three without a pattern.
- **The contract break is a prompt bug, not a model bug.** All three emitted `#decision`, always
  on the same case (`batch/434546a4`). `#decision` is on P0063's vocabulary list (it has been used ≥ 2×),
  and `buildPrompt` says "use them verbatim". The same prompt forbids it as an activity word. `#tim`
  and `#tasks`, which the prompt forbids as project and container tags, are on the list too. The
  vocabulary has to be filtered against the prompt's own prohibitions (task
  `ubun-0929-ns-01M3PMQM3MT7S9BBMM86T6WBNK`).
- **The decision rule has a gap.** With contract at 100 %, all three would be eligible on run 2's
  numbers (low 85, medium 86, high 90 % — all within 5 points). `pickWinner` would then pick **low** because
  it is 4 tokens cheaper than medium: noise, especially since codex's `tokens used` does not count
  cached input. In run 1 medium (84 %) would have been out and low (82 %) too. The rule needs a
  tie band on cost (open, Benni decides).
- **Substance:** all three miss the same session (`2026-09-10-1921`). That points to the label or
  the prompt, not to a model.
- **Project summary input for P0063 is polluted** (heuristic checkpoint text, duplicates). All
  three summarize it equally badly. That is the health check's business
  (`ubun-0929-ns-01M3PHEME0PRESHNTRKSW9MHPN`), not model selection.
- Reliability 100 % across all 264 calls. The production codex failures of 2026-09-29 are
  therefore not the model's fault, see the health check (deleted spawn cwd).

## Run 3: after the fixes (`d5089ab`)

Vocabulary filter, cost tie band (±10 %), spawn cwd = home. Prompt hash `b44e00d88c87`
(new, because the vocabulary block shrank). Run `~/.tim/bench/runs/2026-09-29T13-40-07-168Z`:

| Candidate | Reliability | Latency med / p90 s | Tokens med | Contract | English | ID recall | Invented IDs | Must-keep | Substance |
|---|---|---|---|---|---|---|---|---|---|
| luna-low | 100 % | 6.0 / 11.0 | 1110 | 96 % | 100 % | 29 % | 0 | 84.7 % | 19/20 |
| luna-medium (control) | 100 % | 6.5 / 10.2 | 728 | 100 % | 100 % | 33 % | 0 | 84.7 % | 19/20 |
| luna-high | 100 % | 9.8 / 17.0 | 1177 | 100 % | 100 % | 32 % | 0 | 89.8 % | 18/20 |

**Winner by the rule: luna-high.** `#decision` no longer appears. Low's break is a real model error
(4 subject tags). Medium misses the 5-point band by 0.14 points and is out, so high wins
without a cost comparison.

Caveats:
- Must-keep is stable across all three runs: high 90 %, medium 84–86 %.
- Tokens are not stable (high 2363 → 1177, medium 1178 → 728 between runs 2 and 3; codex does
  not count cached input). "High costs twice as much" therefore does not hold as a measurement,
  only as a tendency.
- Latency: high has the longer p90 (17–19 s vs. 10–11 s), which does not matter for a background job.
