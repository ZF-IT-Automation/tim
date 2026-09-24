# Session-start briefing — goals and scorecard

The session-start path (start-hook directive, `tim_session_start`, `tim_load_project`,
`/tim-continue` → `tim_preview_briefing`) must give an agent the essentials of a
project at once and a clear path to everything else. These goals are the
contract. `scripts/briefing-eval.mjs` scores them; a loop iteration is done only
when every **hard** goal passes on P0063 and no **soft** goal regressed.

Run: `node scripts/briefing-eval.mjs --db <copy-of-tim.db> --project P0063 [--dist <repo-root>] [--json]`
Always against a DB copy, never the live `~/.tim/tim.db`.

Scope: every active project. **P0000 (Inbox)** is exempt — it is a drop zone for
unsorted entries with no sections, sessions or project summary by design, so G3 and S1
cannot apply.

## Hard goals

| ID | Goal | Check |
|----|------|-------|
| G1 | **First screen answers the essentials.** The first 40 lines of `tim_load_project` contain: what the project is (≥1 non-empty Overview/summary line), current state with a date, and the next step or open work. | Overview/summary text present in lines 1–40; an ISO date in lines 1–40; an "Open work"/"Next" block starts before line 40. |
| G2 | **No stale facts in the header.** Header counts/dates come from live data, not frozen text. | Header does not contain a test count or date older than the project's last activity unless labelled historical. |
| G3 | **Project summary covers the project, not one session.** | The summary block states which window it covers (date range or session count ≥ 3), and its newest source date is ≤ 14 days before the project's last activity. |
| G4 | **Recent sessions are recent and plural.** | `Recent Sessions (x/y)`: x ≥ 3 when y ≥ 3; the newest listed date (end of a `start – last` range) equals the newest last-exchange date of a substantive session. |
| G5 | **Continue finds the real handoff.** A trivial newest session (< 3 exchanges, no handoff) does not mask the last substantive one. | `tim_preview_briefing` shows the newest handoff note (if any exists in the last 30 days) and the newest substantive session. |
| G6 | **Directive does not contradict itself.** | The directive never says both "already loaded / do NOT re-fetch" and "call tim_load_project". |
| G7 | **Delta is news, not bookkeeping.** | `[Since last session]` bullets list no session/exchange/batch/checkpoint/summary nodes. |
| G8 | **Open work is trustworthy.** | Every task in "Open work" either was updated in the last 14 days or is visibly marked stale. |
| G9 | **Budget.** | Directive ≤ 4 KB; `tim_load_project` default ≤ 12 KB. |

## Soft goals (no regression; improve when cheap)

| ID | Goal | Check |
|----|------|-------|
| S1 | Every direct child of the project root is a section with `metadata.kind` (no loose root nodes; sessions-root, commits-root and project-path are allowed). | `looseDirectChildren` minus those two kinds = 0 |
| S2 | Bugs render open-first; fixed bugs collapse to a count. | No `[fixed]`/`[done]` bug line before the last open bug line. |
| S3 | One language per entry title; titles ≤ 100 chars. | share of section-child titles > 100 chars |
| S4 | Drill-down paths are named: every collapsed block tells the agent which call expands it. | "… N more" lines carry a tool hint |

## Loop rule

1. Score baseline → `docs/briefing-loop/runs/<date>-baseline.json`.
2. Fix the worst failing hard goal (code in a clone, or data curation via TIM tools).
3. Rescore on a fresh DB copy with the new dist. Keep the change only if no goal regressed.
4. Record the scorecard diff in `docs/briefing-loop/LEDGER.md`. Repeat until all hard goals pass.

A goal that turns out to measure the wrong thing is changed here, with the reason in the ledger — not silently loosened in the script.
