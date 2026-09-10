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

## Collected results

- `arb5` completed one review round. It accepted the three residual fixes in `a28da0d` and found three evidence defects, corrected in `5194c9f` with focused regression tests.
- First #34 implementation `19d140f` and correction `5a17d78` are integrated. Parent corrections `8bfa7d4` and `83a3613` enforce actual UTF-8 sizing and reserved shares across protected sections. The focused briefing suites pass 19 tests at `83a3613`; independent review is running.
- First #33 implementation `f2cfdde` and correction `5fce5b0` are integrated. The second run failed to deliver its report, but its commit was recovered; it still counts as substantive work. Twelve correction tests and two MCP search tests pass locally. No production schema migration was run.
- Terminal sessions from these collected runs are gone. Six unrelated tmux sessions were preserved. Watcher host quota failure and user pause between September 10 and 11 do not count as execution or extra implementation attempts. Precise substantive-work intervals are not inferred from mailbox creation/collection timestamps.

Completed review rounds and measured execution intervals will be recorded with results. Unknown timing is not inferred from calendar age. Historical core-fix runs and review evidence remain in the implementation status and durable team-up mailboxes; reconstruct their ticket attribution before claiming any scope has reached a cap. No program-wide limit follows from the total number of these runs.
