# Implementation status

Updated: 2026-09-11. A worker report is not an integration approval. Issues stay open until the merged result is reviewed, verified and published.

## Current checkpoint — overrides historical progress below

The source through `3f35376` integrates #27–#37 locally. The original README/plan publication remains `4940fab`; source changes are not yet published or deployed. #38 benchmark is prepared but not implemented. #39 final documentation alignment remains open.

| Scope | Current evidence | Remaining acceptance work |
|---|---|---|
| #27–#32 correctness and safety | Core fixes and follow-up hardening are integrated. Independent review accepted the final three residual fixes in `a28da0d`. | Final whole-program regression checks and publication. |
| #33 semantic retrieval | Independent vector candidates, provider injection and fingerprint/CAS index freshness are implemented. Review identified concurrent diagnostic-state leakage and biased hybrid ranking. | Third implementation run `20260911T084329Z-yo1n`, then merged verification. |
| #34 task-aware briefing | Protected section shares, task-aware selection and conservative UTF-8 budgeting are implemented. Review identified preview omission, spacer-block fallback and legacy/footer compatibility defects. | Third implementation run `20260911T084329Z-sljj`, then merged verification. |
| #35 evidence and authority | Typed declared sources, visibility-aware projection and legacy metadata compatibility are implemented. First extension review found no further issue in the correction delta. | Final integrated regression checks and publication; authority remains a declaration, not authentication. |
| #36 temporal memory | Half-open validity, explicit supersession, historical search, epoch comparison and strict merged-interval validation are integrated. | Independent merged review `20260911T084525Z-k84t`. |
| #37 memory health | Flat/batched observed coverage, unknown states, index backlog and validated local sync telemetry are integrated. | Same independent merged review; no live-sync/production-health claim. |
| #38 quality evaluation | Bilingual synthetic fixture and baseline contract is prepared. | Implement after dependency acceptance, then independently review and verify. |
| #39 documentation | README and plan are published; focused new feature docs exist locally. | Align public overview with final verified behavior and publish. |

Parent verification at `3f35376`: isolated build succeeded; seven temporal/coverage/health suites passed **59/59 tests**, including actual CLI and MCP paths. Last completed parent full run at `83a3613`: **1,984 passed, two failed, two skipped**. Both failures are in the assigned semantic correction scope. A new full run is underway; focused green tests do not replace it.

The [run ledger](RUN-LEDGER.md) records stable per-ticket attempts and separately charged integration reviews. User/host quota pauses and terminal-worker idle time are not execution. The user explicitly directed continuation in this host after reporting reset usage. No roster settings were changed. TIM MCP transport is currently unavailable; pending memory updates are not claimed as completed.

## Historical checkpoints

The sections below preserve the sequence of earlier findings. They do not describe current outstanding defects unless repeated in the table above.

## Resumed implementation

The user authorized continuation and correction of the overly broad pipeline-stop rule. Budgets now apply to individual tickets or a separately declared integration scope; completed tmux sessions are not live capacity. Earlier checkpoints below are historical, not a current program-wide blocker.

At `a28da0d`, the recovered evidence implementation `1f09cc8` is merged locally and all three residual findings from the `31cda82` review have corrective code and regression tests. Five focused suites pass: 35 tests passed. A fresh independent review covers the merged evidence contract and these corrections. Semantic retrieval (#33) and task-aware briefing (#34) are running in independent clones. No new source has been published or deployed yet.

## Published

- The rewritten README and implementation plan were published in `4940fab`.
- GitHub issues #27–#39 contain the implementation slices and native blocking relationships.

## Integrated locally, under verification

| Issues | Work | Verification status |
|---|---|---|
| #27 | Preserve replicated tombstones and their LWW versions, including unknown deletions. | Administrative read compatibility was restored after the first review; final integrated checks are pending. |
| #28 | Resolve the extra secret credential and prevent ordinary pushes from bypassing it. | A legacy persisted-queue bypass was reproduced and patched. Durability, idempotency and inherited-secret edge cases require further hardening. |
| #29 | Replace shell-built detached summarizer execution with an argv-based supervisor. | Focused lifecycle tests pass; timeout escalation and public API migration notes are being corrected. |
| #30 | Detect uncovered exchanges after partial summaries. | The merged spawn assertion was corrected; range coverage and repeated-read overhead are being addressed. |
| #31 | Apply summary-first read presentation and trust annotations to section reads. | Depth-one response compatibility and complete returned-entry telemetry are being checked. |
| #32 | Scope retrieval before ranking and pass explicit search modes through MCP. | Further correction is required: status filtering still followed a bounded candidate fetch, and operator handling changed literal search semantics. |
| #39 | Rewrite the README and replace the obsolete capability/vision inventory. | README is published; the capability reference is committed locally and remains subject to final alignment with shipped code. |

## Verification evidence

The first integrated test run at `709bcd7` used `npm test -- --maxWorkers=2` in an isolated checkout:

- 220 test files: 218 passed and 2 failed.
- 1,861 tests: 1,857 passed, 2 failed and 2 skipped.
- Failures were the explicit tombstone-read contract and a stale two-argument spawn assertion after merging two independent fixes.

The independent reviewer confirmed both failures and reported further correctness, safety, compatibility and diagnostics issues. The subsequent hardening commit `e5a9d14` passed its focused 141-test check. That result does not replace a new integrated run or independent review.

A second integrated run at `d946bc7` returned 222 passing test files and 1 failing file: 1,875 tests passed, 1 failed and 2 were skipped. The original two failures were resolved. The remaining failure exposed the #32 change to literal FTS operator semantics, which is included in the active retrieval correction.

The integrated suite at `75c24fd` passed all 225 test files: 1,892 tests passed and 2 were skipped. Independent retrieval review still found cases outside those tests, including unrestricted-root handling and statusless notes matching `todo`. Queue durability/idempotency also remain under correction. A green suite is not treated as resolution of these known findings. The #31 read API has passed review and local integration verification; #35 evidence/authority implementation has started on that accepted dependency.

## Not implemented yet

Evidence/authority (#35) is being implemented. The remaining extension frontier is dependency-gated: independent semantic discovery and index freshness (#33), task-aware briefing (#34), temporal validity (#36), coverage diagnostics (#37), and bilingual quality evaluation (#38). These are planned features, not current guarantees.

## Previous review checkpoint (superseded by resumed implementation)

At `31cda82`, the independent integration review found three remaining defects: hard-delete secret tombstones were blocked before queueing, direct project-label results bypassed alias/name scope, and a supervisor child-spawn failure with no PID did not settle promptly. The coordinator originally reported a blanket pipeline stop without a sufficient per-ticket ledger. That stop was not justified by the total run count. The user subsequently requested the rule correction and completion of the original program.

The evidence worker created commit `1f09cc8`, but its run failed without a completion report. Its code was recovered and merged for verification; a failed completion protocol is not evidence that no substantive work happened.

The parent full-suite run at `31cda82` passed all 227 test files: 1,917 tests passed and 2 were skipped (1,919 total), in 103.25 seconds. The independent adversarial reproductions above expose gaps outside that suite.

## Operational boundary

No production database maintenance, credential changes or hosted deployment is part of this work. Generated output in a live installation has not been replaced merely to test new source. Installation/build-pipeline checks run in isolated development checkouts. Passing deterministic tests would not establish real-model summary quality, live multi-device recovery or agent task success.
