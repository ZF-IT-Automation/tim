# Resumed implementation run ledger

Each substantive run is assigned once to a stable ticket or integration scope. Transport watchers, mailbox waits and cleanup are excluded. Execution time excludes provider waits and terminal idle time. These entries continue existing tickets; they do not reset prior attempts.

| Scope | Run | Role | Accounting |
|---|---|---|---|
| #35 evidence | 20260910T072251Z-m8z9 | implementer | Counts: substantive code committed as `1f09cc8`, although the completion report was lost. Recovered without restarting implementation. |
| #33 semantic retrieval | 20260910T170411Z-eov9 | implementer | Counts when implementation starts. Initial provider-usage probe wait is excluded from execution. |
| #34 task-aware briefing | 20260910T170412Z-gwkq | implementer | One substantive invocation. |
| #34 task-aware briefing | 20260910T171517Z-6t9i | implementer | Second implementation invocation on the same ticket: correct pre-limit selection, partial-block accounting, preview/load consistency and Unicode budget semantics found while integrating `19d140f`. |
| INTEGRATION-20260910-evidence-residual | 20260910T170412Z-arb5 | reviewer | One shared review invocation for merged evidence plus three residual corrections; not charged retroactively to every reviewed ticket. |

Completed review rounds and measured execution intervals will be recorded with results. Unknown timing is not inferred from calendar age. Historical core-fix runs and review evidence remain in the implementation status and durable team-up mailboxes; reconstruct their ticket attribution before claiming any scope has reached a cap. No program-wide limit follows from the total number of these runs.
