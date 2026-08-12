# Summarizer model benchmark: Nemotron 3.5 Lightning vs DeepSeek V4 Flash

Date: 2026-08-12 · measured on the live database (`~/.tim/tim.db`), read-only.

## What was measured

The real summarizer prompts, built by the shipping code (`buildSessionRollupPrompt`,
`buildPrompt`) and executed through the shipping invocation path (`tryCli`, opencode
`run -m <model> --pure --print-logs`). Nothing was mocked and no prompt was hand-written.

| Case | Path | Input |
|---|---|---|
| `rollup/9368f6cf` | session rollup | 8 batch summaries, 11 424 chars |
| `rollup/45dee811` | session rollup | 5 batch summaries, 6 756 chars |
| `rollup/0eff323d` | session rollup | 1 batch summary, 1 840 chars |
| `batch/337a8795` | batch summary | 3 exchanges, 6 886 chars |
| `batch/74c61fd3` | batch summary | 3 exchanges, 5 428 chars |

The two batch cases are the sessions recorded in the open bug *"Summarizer hangs
indefinitely on two specific sessions"* — they were included on purpose as the
adversarial cases.

Models, both on the free tier:

- `opencode/deepseek-v4-flash-free` with `--variant max` — the current head of the chain,
  invoked exactly as `~/.tim/config.json` invokes it.
- `opencode/nemotron-3.5-lightning-free` — 30B MoE, 3B active, OpenMDW-1.1.

Two trials per model per case, probe timeout 180 s (the live chain uses 600 s; the shorter
cap is there to detect a hang, not to sit through one).

## Latency

Seconds, both trials, wall clock including opencode startup (~10 s of every run):

| Case | DeepSeek | Nemotron |
|---|---|---|
| `rollup/9368f6cf` (11.4k) | 19.1 / 15.0 | 82.0 / 113.5 |
| `rollup/45dee811` (6.8k) | 14.9 / 10.1 | 49.1 / 81.9 |
| `rollup/0eff323d` (1.8k) | 7.2 / 8.7 | 172.4 / 68.2 |
| `batch/337a8795` (6.9k) | 8.6 / 13.5 | 151.7 / 32.5 |
| `batch/74c61fd3` (5.4k) | 6.7 / 5.4 | 18.0 / 141.0 |

DeepSeek median ≈ 10 s, Nemotron median ≈ 82 s — roughly 7× slower, and it scales with
queueing rather than with input size: the *smallest* input produced Nemotron's slowest run
(172 s on 1 840 chars). Nemotron's spread (18–172 s) is far wider than DeepSeek's (5–19 s).

**This is free-tier latency, not model latency.** The blog claims up to 4× output speed for
Nemotron; nothing here contradicts the model itself, it measures the free endpoint under
whatever queue it sits in. A paid route would have to be measured separately.

## Reliability

10/10 runs succeeded for each model. No timeouts, no empty stdout, no parse failures.

**The hang did not reproduce.** DeepSeek summarized both "hanging" sessions in 5–14 s.
Whatever killed those two runs during the 2026-08-11 backfill was not the model refusing
this payload; the bug node's premise ("reproduces rather than being a transient CLI
failure") no longer holds under the current code and config. That is a finding about the
bug, not about Nemotron — the bug should be re-tested in its original runner before being
worked on.

## Output

Length, first trial:

| Case | DeepSeek | Nemotron |
|---|---|---|
| `rollup/9368f6cf` | 1 661 | 756 |
| `rollup/45dee811` | 1 525 | 1 002 |
| `rollup/0eff323d` | 1 159 | 567 |
| `batch/337a8795` | 1 534 | 1 245 |
| `batch/74c61fd3` | 596 | 573 |

Nemotron writes 40–65 % of DeepSeek's length. Both stay inside the stated budget, so this
is not a compliance difference; it is a density difference. Read side by side:

- **Facts are accurate on both.** Nemotron kept commit hashes, table sizes and the
  `staging_disabled` trigger semantics correctly; no invented content was found in the
  five outputs.
- **Nemotron drops the *why*.** On `rollup/45dee811` DeepSeek carried the decision trail
  (why `resumeSession` was unusable, which file/line, what the fix commit changed);
  Nemotron reduced the same material to what happened. The rollup is what the next session
  reads first, and the reasoning is the part that cannot be re-derived from the code.
- **Language.** DeepSeek mirrors the source language (German sessions come back German);
  Nemotron answered in English on German input in every case.
- **Tag contract.** `batch/337a8795`: both compliant. `batch/74c61fd3`: Nemotron emitted
  `TAGS: #session-continuity #tim-mcp #decision #implementation` — `#decision` is not on
  the closed activity list (`#design #implementation #debugging #review`), and the prompt
  says invent no other activity word. DeepSeek emitted `#tim-project` there, which is a
  container tag the prompt also forbids. One violation each, different kinds; Nemotron's is
  the kind that re-opens the tag-drift problem the vocabulary block exists to close.

## Recommendation

Do not put Nemotron at the head of the chain. It is 7× slower on this route with no
reliability advantage, less dense output, and it answers in English on German input.

It earns a place as the **last fallback, behind codex**. Ahead of codex was considered and
rejected by the user: codex produces the denser, language-preserving summary, so the cheaper
model should not displace it on the first retry — Nemotron is the net below, for when both
earlier entries fail, where a free run beats no summary at all.

Applied to `~/.tim/config.json` on 2026-08-12 (backup:
`~/.tim/config.json.bak-pre-nemotron-20260812`):

```jsonc
// summarizer.chain
[
  { "cli": "opencode", "model": "deepseek-v4-flash-free", "provider": "opencode", "args": ["--variant", "max"] },
  { "cli": "codex", "model": "gpt-5.6-luna", "args": ["-c", "model_reasoning_effort=high"] },
  { "cli": "opencode", "model": "nemotron-3.5-lightning-free", "provider": "opencode" }
]
```

## Scope

Rollup and batch-summary paths only. `generateProjectSummary` was not measured, and the
`remember` chain (`claude-3-5-haiku`) is a separate chain that this says nothing about.
Two trials per cell is enough to show a 7× gap; it is not enough to rank two models that
land within a factor of two of each other.

Raw outputs and `results.json`:
`/tmp/claude-1000/-home-bbbee-projects-tim/ee881666-7c90-4890-9148-f67f6b5c3aaf/scratchpad/`
(benchmark script `bench.mjs` lives there too — throwaway, not part of the repo).
