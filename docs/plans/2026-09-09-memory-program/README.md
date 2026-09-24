# Memory reliability and project continuity

## Goal

Deliver an accurate public introduction to TIM, fix the eleven findings from the 2026-09-09 review, and extend memory with evidence, temporal validity, task-aware context, coverage diagnostics and repeatable quality evaluation. The user authorized plans, tickets, team-up implementation and independent verification.

## Starting point

Baseline commit: `acb738b`. The review ran 215 test files: 1829 tests passed and 2 were skipped. TypeScript checking and build completeness passed. Those results are historical baseline evidence, not a claim about subsequent commits or real-model quality.

## Tickets and blocking edges

Each ticket is a complete observable behavior. GitHub is the execution tracker; native blocking dependencies mirror the table. Local ticket files capture the acceptance contract at publication time.

| Ticket | Delivers | Blocked by |
|---|---|---|
| [#27](https://github.com/ZF-IT-Automation/tim/issues/27) | Durable deletion versions; delayed sync updates cannot resurrect old entries | None |
| [#28](https://github.com/ZF-IT-Automation/tim/issues/28) | Extra secret encryption through ordinary CLI and automatic sync | None |
| [#29](https://github.com/ZF-IT-Automation/tim/issues/29) | Safe asynchronous summarizer launch and lock cleanup | None |
| [#30](https://github.com/ZF-IT-Automation/tim/issues/30) | Summary catch-up based on actual covered exchange sequences | None |
| [#31](https://github.com/ZF-IT-Automation/tim/issues/31) | Consistent summary-first section reads, child options, trust and usage | None |
| [#32](https://github.com/ZF-IT-Automation/tim/issues/32) | Filter-before-limit scoped recall and honored search modes | None |
| [#33](https://github.com/ZF-IT-Automation/tim/issues/33) | Independent semantic candidates and refreshed embeddings | #32 |
| [#34](https://github.com/ZF-IT-Automation/tim/issues/34) | Priority-preserving task-aware briefing within a context budget | #32, #31 |
| [#35](https://github.com/ZF-IT-Automation/tim/issues/35) | Inspectable evidence and preserved memory authority | #31 |
| [#36](https://github.com/ZF-IT-Automation/tim/issues/36) | Superseded decisions and current/as-of recall | #35, #32 |
| [#37](https://github.com/ZF-IT-Automation/tim/issues/37) | End-to-end memory coverage and actionable backlog | #30, #33 |
| [#38](https://github.com/ZF-IT-Automation/tim/issues/38) | Repeatable bilingual quality scenarios and explicit baselines | #33, #34, #36, #37 |
| [#39](https://github.com/ZF-IT-Automation/tim/issues/39) | New README, sourced comparisons and consistent public documentation | None; refresh status after code integration |

## Acceptance and verification

1. Regression tests reproduce the reviewed bugs at actual public call paths and event sequences.
2. New capabilities have consumers in supported MCP/CLI workflows, not just unused helpers.
3. The existing test suite and TypeScript build pass after integration, with failures and skips explicitly reported.
4. Comparison claims cite primary sources and distinguish existing features from roadmap items.
5. Quality output distinguishes deterministic fixtures, optional real-model checks and actual agent-task measurements. No invented performance gains.
6. Original exchanges remain available; explicit migrations and maintenance are not applied to a production database by the implementation program.

## Design constraints

Keep Node.js 22 compatibility. Prefer additive metadata and existing interfaces over new packages, dependencies or redundant tools. Scope and suppression apply consistently before retrieval limits. Evidence labels describe provenance; they do not authenticate a caller or turn stored instructions into system policy. Temporal validity preserves historical content and supports explicit corrections rather than autonomous truth rewriting.

The implementation of extensions is a bounded first usable version, with behavior specified by each ticket. Hosted infrastructure, a full project-management system, reminders, credential rotation and production deployment are outside this program.

## Execution

Work the unblocked frontier. Each parallel writer receives its own full clone and a concrete acceptance contract. Integrate completed commits, then run a fresh independent review of the combined result. Ticket closure requires integration and verification evidence. The root checkout may be a live installation; clean builds and lifecycle installs belong in isolated clones.

## Failure and recovery

Keep ticket/run state and committed work when a worker fails. A terminal mailbox or an existing tmux session alone does not prove implementation succeeded. Inspect the diff and checks before declaring a slice complete. Revert an individual implementation commit if required; preserve source memories and production data.
