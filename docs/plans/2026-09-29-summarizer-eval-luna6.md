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

**Winner by the fixed rule: none.** Every candidate has one contract break in 27 batch
calls, so the chain stays as it is (`gpt-6-luna` medium).

## Findings

- **No difference between low and medium.** Across two runs they are equal on tokens, latency and
  must-keep (85–86 %). Low broke the contract more often in run 1.
- **High keeps more (90 % vs. 84–86 %), at twice the tokens and a longer p90.** The gain is in
  the batch summaries: high drops no identifiers and no commands (`codex-poke`,
  `migrate-schema`, `grate`, `h.264`), where low and medium sometimes do. On rollups and the
  project summary all three are equal.
- **The contract break is a prompt bug, not a model bug.** All three emitted `#decision`, always
  on the same case. `#decision` is on P0063's vocabulary list (it has been used ≥ 2×), and
  `buildPrompt` says "use them verbatim". The same prompt forbids it as an activity word. `#tim`
  and `#tasks`, which the prompt forbids as project and container tags, are on the list too. The
  vocabulary has to be filtered against the prompt's own prohibitions. After that fix, run the
  protocol again: high would then win on must-keep, medium if high's extra cost is not wanted.
- **Substance:** all three miss the same session (`2026-09-10-1921`). That points to the label or
  the prompt, not to a model.
- **Project summary input for P0063 is polluted** (heuristic checkpoint text, duplicates). All
  three summarize it equally badly. That is the health check's business
  (`ubun-0929-ns-01M3PHEME0PRESHNTRKSW9MHPN`), not model selection.
- Reliability 100 % across all 264 calls. The production codex failures of 2026-09-29 are
  therefore not the model's fault, see the health check (deleted spawn cwd).
