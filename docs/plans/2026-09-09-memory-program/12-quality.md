# feat(eval): add repeatable memory quality benchmark scenarios

## What to build

A documented local command runs realistic bilingual memory scenarios and compares no-memory, fixed handoff text and TIM retrieval without requiring paid APIs.

## Blocked by

- https://github.com/ZF-IT-Automation/tim/issues/33
- https://github.com/ZF-IT-Automation/tim/issues/34
- https://github.com/ZF-IT-Automation/tim/issues/36
- https://github.com/ZF-IT-Automation/tim/issues/37

## Seam

Standalone CLI/script artifact with structured benchmark output.

## Acceptance criteria

- [ ] Versioned fixtures cover synonyms, similar projects, corrected decisions, partial continued sessions and long noisy histories.
- [ ] Report expected/found/missing/irrelevant evidence, retrieval precision/recall/rank, context size and latency, plus explicit provider/mode.
- [ ] Baselines consume the same fixture questions and a defined fixed handoff budget; label synthetic checks and do not claim agent task success without actual agent execution.
- [ ] Deterministic CI smoke checks and an optional real-provider mode are separate; missing optional model results are explicit skips.
- [ ] Report provenance of fixture/gold labels, repeatable command and limitations; no fabricated benchmark improvements.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent
