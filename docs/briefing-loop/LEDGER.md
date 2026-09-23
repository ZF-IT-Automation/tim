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

## Goal changes
- S1: sessions-root and commits-root are legitimate non-section roots (scorer counted them as loose).
- G7: scorer only read the header line; now inspects the delta bullets in hook and preview.
- G8: scorer matched only `in_progress`; now all open statuses incl. the legacy metadata shape.
- G5: scorer dated handoffs by the summary root's `updated_at`, which metadata writes bump; now by the owning session's date.

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
