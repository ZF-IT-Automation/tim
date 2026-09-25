# Briefing loop — ledger

Each row is one scored iteration on P0063 (`scripts/briefing-eval.mjs`, goals in `GOALS.md`).
Raw scorecards: `runs/`.

| Date | Iteration | Code | Data | Hard | Soft | Load bytes | Note |
|------|-----------|------|------|------|------|-----------|------|
| 2026-09-23 | baseline | live dist (2026-09-04) | as found | 0/9 | 1/4 | 19,474 | 12 in_progress tasks already shipped; summary from one August session; Recent Sessions 1/1 |
| 2026-09-23 | curation | live dist | curated | 1/9 | 3/4 | 19,931 | 15 tasks closed, Overview filled, sections typed |
| 2026-09-23 | C1 | b077fde | curated | 8/9 | 3/4 | 8,977 | handoff read path, ACTION line, delta filter, Now block, live header |
| 2026-09-23 | C2 | d305f00 | curated | 8/9 | 4/4 | 8,977 | Overview preview, stale collapse, drill-down hints |
| 2026-09-23 | C3–C4 | 015ce70 | curated | 8/9 | 4/4 | 8,977 | substantive-session predicate, worker no-op, summarizer substance verdict |
| 2026-09-23 | review | — | — | — | — | — | independent review: 14 findings (5 major) |
| 2026-09-23 | C5–C7 | 4f2a2f2 | curated + summary | 9/9 | 4/4 | 8,242 | review fixes; order Now/Rules first; project-relative verdict 19/20 |
| 2026-09-23 | deployed | 4f2a2f2 | live | 8/9 | 4/4 | 8,849 | G5: handoff of another session not shown in continue; harness notifications logged as turns → C8 |
| 2026-09-24 | C8 deployed | 649d04c | live + backfill | 8/9 | 4/4 | 9,000 | backfill's own LLM calls created 97 junk sessions → previous session hidden; fixed in 795341f (summarizer CLIs run as workers, scan past bursts) |
| 2026-09-24 | review 2 | — | — | — | — | — | 11 findings, 2 blockers in C8 logging (whitespace collapse, text loss after unclosed tag) — live ~40 min; hotfix 08cb814 stores prompts verbatim |
| 2026-09-24 | C9 deployed | dc413fc | live | 9/9 | 4/4 | 9,000 | review-2 fixes; scorer dates handoffs by session |
| 2026-09-24 | review 3 + C10–C12 | 50b5c33 | live, all projects | 9/9 (P0063) | 4/4 | 9,000 | 2 summarizer blockers (coverage loop/stall on harness-only turns) fixed in C11; English summaries; legacy harness turns flagged (140); pushed, CI green |
| 2026-09-24 | iteration 2 | 50b5c33 | live, all active projects, substance backfill + summaries regenerated | 9/9 in P0054, P0062, P0063, P0075, P0076, P0077; P0073 8/9 (G4); P0078 8/9 (G1: no open work at all); P0072 archived 7/9; P0000 Inbox 7/9 | 4/4 (Inbox 3/4) | — | removed dead summarizer tier opencode/deepseek-v4-flash-free |
| 2026-09-24 | iteration 3 | 7586ea8 | live copy, all active projects | 9/9 in all 8 active projects (P0054, P0062, P0063, P0073, P0075, P0076, P0077, P0078) | 4/4 | — | multi-day sessions render `start – last exchange`; empty Now block says "no open work"; Sections count excludes the header-rendered Overview; Inbox exempt |
| 2026-09-24 | iteration 4 | 0bd3e78 | live copy, all active projects | 9/9 in all 8 | 4/4 | — | session activity = exchanges + handoff checkpoints (summaries/repeat checkpoints no longer reorder sessions); prompt recall drops transcript turns (exchange, checkpoint) and duplicate lines — it had replayed old user prompts as instructions |
| 2026-09-24 | iteration 5 | df088b2 | live copy after P0063 task triage | 9/9 in all 8 (hook now scored per project) | 4/4 | — | stale tasks sit under a triage instruction (done → status, obsolete → irrelevant, valid → tim_verify); tim_show lines carry date + id; P0063: 3 tasks closed, 12 verified, 1 carried over |
| 2026-09-24 | review 4 + iteration 6 | 6be8bc4 | live copy | 9/9 in all 8 | 4/4 | — | review 4: 0 blocker, 0 major, 7 minor — all fixed. Staleness now counts days of project work (a paused project does not age); stale previews rotate oldest-first so forgotten tasks resurface; fresh overflow is counted instead of dropped; recall excludes transcript kinds in SQL and dates every line; legacy handoffs count via the summary root's note |
| 2026-09-24 | iteration 7 | 1107a29 | live copy | 9/9 in all 8 | 4/4 | — | log records with a task-id back-reference in metadata.task no longer count as open tasks (4 in P0062); P0–P3 and critical/high/medium/low ranked on one scale (P0 had sorted below medium) via one shared taskPriorityRank; load's Now-block compaction kept only '- [' lines and dropped the triage and overflow lines |
| 2026-09-24 | review 5 + iteration 8 | fc98966 | live copy | 9/9 in all 8 (G8 now also checks coverage) | 4/4 | — | review 5: 0 blocker, 3 major, 8 minor — all fixed except m5 (design call). Stale window rotates per work day; staleness clock = touched_at (title/body/status change) or tim_verify, not updated_at (reorders no longer refresh the backlog); stale lines carry ids; stale block reserved before fresh lines fill the budget; tasks in a merged-away tree belong to the merge target (17 in P0062 surfaced) |
| 2026-09-24 | review 6 + iteration 9 | 5be2c73 | live copy | 9/9 in all 8 | 4/4 | — | review 6: 0 blocker, 1 major, 7 minor — all fixed. MA1: converting a legacy task flag to the object form now keeps status/priority/due (a reorder had reopened done tasks; no live damage found); rotation = golden-ratio start on a stable hash ring (steady backlog: every stale task within ~0.93·n work days; growing backlog cannot freeze it); stale count reserved even when the full block cannot fit; touched_at/verified_at are system-owned; merged_into follows chains to a live project; priority twins string-only with the same source; logged work (children, back-references) counts as touching a task (review-5 m5) |
| 2026-09-24 | review 7 + iteration 10 | 5b2da74 | live copy | 9/9 in all 8 | 4/4 | — | review 7: 0 blocker, 0 major, 4 minor, 5 nits — minors and nits fixed. Future touch clocks capped at now; legacy→object conversion drops the top-level twins; getTasks status/due read the same source as the record; scorer follows merge chains; rotation bound stated correctly; CHANGELOG entry |
| 2026-09-24 | review 8 + cold read 1 + iteration 11 | 73e5020 | live copy | 9/9 in all 8 | 4/4 | — | review 8: 0 blocker, 2 major, 3 minor — fixed (future clocks dropped not clamped, stripped on write; tasks outside every project refused on write, 2 orphaned P0076 tasks moved; tim_show and tim_resume_topic use the task clock/status). Cold read by a context-free agent: P0063 6/10, P0062 3/10 → handoffs dated by write time and flagged when newer sessions lack one; ids on every task line; heading markers stripped; superseded rules collapsed to a count; 'X: X' rule lines deduped; no duplicate section line; P0063 State line and SQL-rule conflict curated |
| 2026-09-24 | cold read 2 + iteration 12 | d377e35 | live copy | 9/9 in all 8 | 4/4 | — | cold read 2 (mid-session snapshot): P0063 6/10, P0062 3/10. Priorities shown on one P0–P3 scale; rule previews skip 'Split from … on …' provenance; omission footer counts section bodies instead of listing them; session footer says 'substantive' and keeps short ones apart; a handoff outgrown by ≥3 newer substantive sessions becomes a pointer; data: P0054 session with 5 handoffs moved out of P0062 |
| 2026-09-25 | S2 tighten | jev/t5-briefing-judge | snapshot copy tim-20260925-0800 | 9/9 on the 8 active projects | P0073 and P0076 3/4 (S2); the other six active projects 4/4 | — | S2 now fails when a fixed or done bug line sits before the last open bug. Jev column on the scorecard is advisory and does not change hard/soft counts. |

## Goal changes
- S1: sessions-root and commits-root are legitimate non-section roots (scorer counted them as loose).
- G7: scorer only read the header line; now inspects the delta bullets in hook and preview.
- G8: scorer matched only `in_progress`; now all open statuses incl. the legacy metadata shape.
- G1: scorer accepted only an `Open work`/`Next` heading; now also `── Now ──` (the new first-screen block).
- G2: header regex now accepts `last activity <date>` (the new header wording).
- S1: `project-path` entries are legitimate root children.
- G2: scorer resolves the project and last activity like the renderer (it had read a stale `merged-into` row for P0062).
- G4: Recent Sessions is ordered by activity; the scorer compared its first line against the newest session *start* date, so a long session that began earlier failed. Now both sides use the last exchange (the renderer shows `start – last`).
- Hook texts: the scorer ran the start hook from a fixed cwd (`~/projects/tim`), so every project was scored against P0063's hook; G8 only passed elsewhere because P0063's open work was all stale. Each project now gets its own marker dir.
- G8: "updated in the last 14 days" aged every task of a paused project. Now: touched within the project's last 7 days of work (days with a logged exchange).
- G8: stale lines are recognised by the ` · stale since` suffix (the word matched titles like "Stale Cache Alert"); task rows use the product's marker and touch rules; new coverage check: named + counted lines = open tasks in the DB.
- Scope: P0000 Inbox exempt (no sections/sessions/summary by design).
- G5: scorer dated handoffs by the summary root's `updated_at`, which metadata writes bump; now by the owning session's date.
- S2 (2026-09-25): the scorer only flagged a fixed bug before any open bug, and it only read a `── Bugs ──` block, so an indented Bugs section with a done line between open bugs passed. It now matches GOALS.md: no `[fixed]`/`[done]` line before the last open bug line. On snapshot `tim-20260925-0800`, P0073 and P0076 fail S2; P0054, P0062, P0063, P0075, P0077 and P0078 still pass.

## Session filter — measurement behind the decision (2026-09-23, 591 sessions)

| turns | sessions | with handoff | ⌀ agent chars |
|------:|---------:|-------------:|--------------:|
| 0 | 130 | 7 | 0 |
| 1 | 387 | 0 | 548 |
| 2 | 18 | 0 | 2,767 |
| 3–4 | 24 | 1 | 6,070 |
| 5–9 | 20 | 1 | 9,240 |
| 10+ | 44 | 3 | 36,768 |

1-turn sessions: 237 empty prompts, 56 team-up watchdog judges, ~30 worker prompts.
