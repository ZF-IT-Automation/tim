# Resumed implementation run ledger

Each substantive run is assigned once to a stable ticket or integration scope. Transport watchers, mailbox waits and cleanup are excluded. Execution time excludes provider waits and terminal idle time. These entries continue existing tickets; they do not reset prior attempts.

| Scope | Run | Role | Accounting |
|---|---|---|---|
| #35 evidence | 20260910T072251Z-m8z9 | implementer | Counts: substantive code committed as `1f09cc8`, although the completion report was lost. Recovered without restarting implementation. |
| #33 semantic retrieval | 20260910T170411Z-eov9 | implementer | Counts when implementation starts. Initial provider-usage probe wait is excluded from execution. |
| #33 semantic retrieval | 20260910T171852Z-ax51 | implementer | Second implementation invocation on the same ticket: validate all vector paths, prevent asynchronous stale embedding commits, complete suppression-before-bound and backlog/provider diagnostics contracts found while integrating `f2cfdde`. |
| #34 task-aware briefing | 20260910T170412Z-gwkq | implementer | One substantive invocation. |
| #34 task-aware briefing | 20260910T171517Z-6t9i | implementer | Second implementation invocation on the same ticket: correct pre-limit selection, partial-block accounting, preview/load consistency and Unicode budget semantics found while integrating `19d140f`. |
| INTEGRATION-20260910-evidence-residual | 20260910T170412Z-arb5 | reviewer | One shared review invocation for merged evidence plus three residual corrections; not charged retroactively to every reviewed ticket. |
| #36 temporal validity | 20260910T220440Z-x4km | implementer | First implementation invocation; consumes locally tested evidence and retrieval contracts. |
| #37 memory health | 20260910T220441Z-v6x8 | implementer | First implementation invocation; consumes locally tested coverage and non-generating index-health contracts. |
| INTEGRATION-20260911-memory-extensions | 20260910T220747Z-oo7e | reviewer | First review of merged #33/#34 and #35 correction delta at `83a3613`; charged once to this shared extension integration scope. |
| #36 temporal validity | 20260910T221103Z-iern | implementer | Second substantive implementation; completed `d23a391`, integrated and followed by parent validation fix `3f35376`. |
| #37 memory health | 20260910T220945Z-nnvh | implementer | Second substantive implementation; completed `50f0a57`, integrated. |
| #33 semantic retrieval | 20260911T084329Z-yo1n | implementer | Third substantive implementation: per-call semantics, hybrid ranking, provider identity, deterministic tests and index-corpus documentation; review F1/F5/F6/F8. |
| #34 task-aware briefing | 20260911T084329Z-sljj | implementer | Third substantive implementation: useful bounded previews, spacer-aware partial blocks, reserved footer/NEXT and legacy compatibility; review F2/F3/F4/F7. |
| INTEGRATION-20260911-memory-extensions | 20260911T084525Z-k84t | reviewer | Second fresh merged review, frozen `3f35376`, focusing on #36/#37 and shared coverage/search boundaries; charged once. |
| #38 bilingual quality benchmark | 20260911T085338Z-os1c | implementer | First substantive implementation at locally tested dependency seams `42fffcf`. Independent review still gates program publication; no claim that dependency tickets are closed. |

## Collected results

- `yo1n` failed its completion protocol but committed `3c7e3ed`; recovered and merged without another worker invocation. Parent `24ad366` corrects the still-missing enabled-provider/no-index fallback and adds the actual regression. Nine focused search/MCP/temporal suites pass **77/77 tests**. The unavailable-provider-only test was insufficient and was not accepted as proof of this case.
- `sljj` completed `483d2c9`; parent `2e9aad9` adds exact separator accounting before protected response tails. Two briefing suites pass **27/27 tests**, including all budgets 1–400 bytes with Unicode and the protected NEXT hint.
- Parent whole-suite run at `3f35376` completed with **2,037 passed, two failed, two skipped** across 241 files; the two known semantic failures were subsequently corrected above. A new full run at `2e9aad9` is pending.
- At `3f35376`, parent isolated build and seven targeted suites pass **59/59 tests**, including actual CLI/MCP temporal and health paths. This is not a full-suite result.
- `oo7e` completed the first extension integration review: eight reproducible/documentation findings, assigned to #33/#34 corrections above. Evidence correction checks produced no further finding. The last full suite on `83a3613` had **1,984 passed, two failed, two skipped**; hybrid usage ranking and network-dependent MCP metadata tests are included in #33 correction scope. Temporal worker's later full run also failed the known usage test; it is not accepted as a flake.
- `iern` and `nnvh` completion reports were recovered after their Codex transport watchers hit host quota. Their external workers completed; no duplicate implementations were launched. Parent found and corrected missing timezone-offset capture and combined-interval validation before the second independent review.
- User explicitly reported reset usage and instructed the same host to continue. A fresh probe returned `pty-lock-contention`, so cached quota output is not treated as a newly verified usage reading. No provider/account configuration was changed. Long host/user waits are excluded from execution budgets.
- TIM MCP transport is currently closed. Run outcomes remain durable here and in mailboxes; memory task updates are pending reconnection rather than being reported as saved. CLI checkpoint succeeded before this continuation.

- `arb5` completed one review round. It accepted the three residual fixes in `a28da0d` and found three evidence defects, corrected in `5194c9f` with focused regression tests.
- First #34 implementation `19d140f` and correction `5a17d78` are integrated. Parent corrections `8bfa7d4` and `83a3613` enforce actual UTF-8 sizing and reserved shares across protected sections. The focused briefing suites pass 19 tests at `83a3613`; independent review is running.
- First #33 implementation `f2cfdde` and correction `5fce5b0` are integrated. The second run failed to deliver its report, but its commit was recovered; it still counts as substantive work. Twelve correction tests and two MCP search tests pass locally. No production schema migration was run.
- Terminal sessions from these collected runs are gone. Six unrelated tmux sessions were preserved. Watcher host quota failure and user pause between September 10 and 11 do not count as execution or extra implementation attempts. Precise substantive-work intervals are not inferred from mailbox creation/collection timestamps.

Completed review rounds and measured execution intervals will be recorded with results. Unknown timing is not inferred from calendar age. Historical core-fix runs and review evidence remain in the implementation status and durable team-up mailboxes; reconstruct their ticket attribution before claiming any scope has reached a cap. No program-wide limit follows from the total number of these runs.
