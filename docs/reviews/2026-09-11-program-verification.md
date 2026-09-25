# Memory program verification

The implementation program covers GitHub issues #27–#39. This record distinguishes independent review from coordinator follow-up checks and does not certify production readiness.

## Tested source

Final implementation and regression baseline: `41cbb4e`. Source changes after the third independent review are in `80ce5f9`; `41cbb4e` adds the actual MCP repair regression. Later commits update documentation and execution records only.

The coordinator verified the merged source in isolated full clones. No live installation was rebuilt and no production database migration or maintenance was performed.

## Independent review and correction

The extension integration scope used three independent reviews: `oo7e`, `k84t`, and `5e24`. They received source and public contracts, not implementation plans or worker reports. The earlier evidence/residual review was tracked separately as `arb5`.

The last review was not a clean sign-off. Its seven findings were corrected by the coordinator and checked with focused regressions and subsequent whole-suite runs:

| Finding | Correction and verification |
|---|---|
| Saturated benchmark recall | Index 120 in-project distractors, exceeding the ten retained hits. A nonsense-query negative control changes expected synonym recall from 1 to 0. |
| Missing title-only evidence and noise | Put fixture-reference markers in rendered titles. Regression checks retained log noise and decision/idea references in briefing metrics. |
| Borrowed provider metadata | Baseline and full-text briefing rows report `modelId: null`, `state: not_used`. |
| Unscored partial session | The session question expects the partial-summary reference; health independently verifies three observed exchanges, two covered and one pending. |
| Unrepairable unmanaged imported edge | Explicit `discardUnmanaged` removes only an edge when the target has no managed state. Store and actual MCP tests verify repair and refusal to bypass a real supersession. |
| Ambiguous FTS provider state | Per-call FTS diagnostics report `not_used`, while index health retains its separate availability vocabulary. Concurrent search tests cover the distinction. |
| Understated diagnostic cost | Documentation states that freshness checks materialize and hash eligible text in JavaScript, with corpus-dependent time and transient memory. |

These corrections received coordinator verification, not a fourth independent review. No additional specialist review was started without a budget extension.

## Fixture observations

The final synthetic CLI run used seven questions and eight expected evidence references, with a 4096-byte budget per question/mode:

| Mode | Expected references found | Missing | Irrelevant references | Macro precision | Macro recall |
|---|---:|---:|---:|---:|---:|
| No memory | 0 | 8 | 0 | Not applicable | 0 |
| Fixed handoff | 6 | 2 | 22 | 0.2143 | 0.7500 |
| TIM | 8 | 0 | 60 | 0.1206 | 1.0000 |

The result exposes a trade-off rather than a universal win: TIM retains more expected references and more irrelevant ones in this small synthetic fixture. Metrics score retained fixture references, not understanding of full facts, actual agent-task success or maintenance savings. The larger indexed distractor pool and altered-query negative control prevent recall from succeeding merely because all records fit in the result set.

Real-provider opt-out was checked separately: `TIM_EMBEDDING_REAL_MODEL=1 TIM_EMBEDDING_DISABLED=1` returns an explicit skip with no questions or mode summaries. The independent reviewer exercised a cached real model on the earlier fixture; that run is not a quality comparison for the corrected final fixture.

## Limits and remaining risk

- Two existing associative-recall tests are skipped: chain timeout and database-lock handling. They are not passing checks.
- Known dependency advisories remain in [#40](https://github.com/ZF-IT-Automation/tim/issues/40), including a critical archive-parser advisory. See the [separate audit](2026-09-11-dependency-audit.md). No forced major upgrade was performed.
- Local sync tests do not establish live multi-device recovery or hosted deployment safety. Evidence authority remains a declaration, not authentication.
- TIM MCP transport was closed during closeout. Durable Git/issue/ledger records remain available; memory task updates are not claimed as completed.

See the [implementation status](../plans/2026-09-09-memory-program/IMPLEMENTATION-STATUS.md) for exact final test counts, publication state and commands.
