# Feature Spec — Topic recall: shared tag vocabulary, tag-only retrieval, resume by topic

Status: grilled 2026-08-11, all open points decided. Build order: merge
`17c6699`, then `2026-08-11-handoff-note-home.md`, then this spec.

## Goal

Past work stops being injected by recency and starts being retrieved by topic.
The summarizer reuses the project's existing tag vocabulary instead of inventing
a fresh one per run, a tag can be queried on its own (no full-text query
required), and a new resume-by-topic path returns everything carrying that tag in
chronological order — batch summaries across several sessions, plus the tasks,
bugs and ideas that share it. The automatic session-start briefing shrinks to
structure only; recalling past work becomes a deliberate act.

## Why / context

The briefing selects the previous session with `listResumableSessions(project, 1)`
— newest session, topic-blind. When the new session is about something else, that
block is pure noise. Tag-based recall is the many-to-many answer: a session that
touched three topics shows up under all three, where a topic container would have
hidden it in two.

The tagging half already exists and shipped. **Read `docs/hashtag-plan.md`
first** — it is the plan that built this, and it is implemented: the
summarizer prompt asks for a `TAGS:` line (`generate-summary.ts:61`),
`extractTags` normalizes to lowercase kebab-case (`:99`), and
`aggregateSessionTags` rolls batch tags up onto the **Summary root**
(`session.ts:734`). What is missing is vocabulary discipline, a retrieval path,
and the consumer.

## Measured starting point

- `tim stats`, 9567 entries. The top tags are structural (`#exchange` 2262,
  `#session-summary` 732, `#session` 376, `#batch-summary` 357), then content
  tags follow (`#architecture` 151, `#schema` 116, `#tim` 115, `#sync` 108).
- Content tags already cross-link: `tag=#summarizer` in P0063 returns 6 entries
  across two tasks, a bug, an idea and a batch summary from another session.
- Vocabulary drifts between runs. Two batch summaries, same project, two days
  apart: `#queue` `#summarizer` `#session-continuity` `#tim-hooks` `#performance`
  (2026-08-10) versus `#queue-planning` `#briefing-raw-tail` `#unpushed-commit`
  `#session-cache-steal` (2026-08-11). Both tag sets were read directly off the
  nodes; the drift (`#queue` versus `#queue-planning` for the same subject) is
  measured. How often the 2026-08-11 tags recur elsewhere is NOT measured — see
  the tag-filter caveat below, which makes any such count unreliable today.
- `tim_search`'s `tag` argument is a **post-filter on FTS results**
  (`server.ts:2260`), not a tag lookup: it can only narrow what the full-text
  query already ranked into the candidate set. Any attempt to count a tag's
  occurrences today under-reports it. This is a second reason for criterion 4,
  beyond convenience.
- Summary roots look untagged because `aggregateSessionTags` keeps only tags with
  `count >= 2` across sibling batches (`session.ts:748`). A session with a single
  batch can never clear that bar, so its Summary root keeps `#session-summary`
  alone.
- RESOLVED 2026-08-11: the retired structural tags are P0063's own subject
  matter — `#checkpoint`, `#session`, `#sessions`, `#exchange` are exactly what
  the summarizer would put on a summary about checkpoint reaping or session
  continuity. They are no longer written automatically, but they were briefly
  also banned as content tags, which would have left this project's vocabulary
  missing four of the words it is most about. The ban is lifted: only the write
  sites are gone, the words stay legal (`RETIRED_STRUCTURAL_TAGS`, see
  `2026-08-11-handoff-note-home.md` criterion 9).
- The share of tags used exactly once is UNKNOWN: `stats()` returns only the top
  20 and no tag-listing API exists. The project-scoped query built for criterion 1
  answers it as a side effect — report the number once, it decides nothing but it
  sizes the prompt.

## Acceptance criteria

1. The summarizer prompt carries the project's **complete** content-tag
   vocabulary — every distinct tag of the project except `#session-summary` and
   `#batch-summary`, the two that are still stamped automatically — sorted by
   frequency descending, with the instruction to reuse a fitting
   existing tag before inventing a new one. DECIDED 2026-08-11: no top-N cap. A
   rare tag that the summarizer never sees gets rarer; the point of the list is
   to stop that spiral.
2. Vocabulary lookup is scoped to the project being summarized, and its failure
   never blocks summarization: no vocabulary means the prompt falls back to
   today's wording.
3. `aggregateSessionTags` threshold becomes batch-count dependent: `count >= 1`
   when the session has one or two batches, `count >= 2` from three batches on.
   Short sessions have no topic drift to filter, only tags to lose; long ones do,
   and a Summary root carrying twelve tags matches every topic and sharpens none.
4. Tag-only retrieval: `tim_search` accepts `tag` without `query` and returns the
   entries carrying that tag, chronologically ascending, capped by `topK`. Today
   `query` is mandatory and `tag` is only a filter on it, so "give me everything
   tagged `#frontend`" has no path at all.
5. New `tim_resume_topic(tag)` returns, for the bound project: every batch summary
   carrying the tag in chronological order with its session id and date, every
   task/bug/idea carrying it, and — from the **newest matched session only** —
   its handoff note and its unsummarized raw turns. DECIDED 2026-08-11: exactly
   one note, the newest hit's, not one per matched session.
6. If the newest matched session has no handoff note, the output says so
   explicitly, naming that session's id and date. It must **never** fall back to
   an older session's note: a missing note is information, a foreign one is a
   false statement about the current state.
7. The raw turns come from the same session as the note — never a note from
   session X beside raw turns from session Y. The reader already exists:
   `recentExchanges` in `session-briefing.ts:130-155`, merged with `17c6699`.
8. The **automatic** session start stops asking for past work. AMENDED
   2026-08-11: gate, do not delete. `collectDirectiveBriefing` takes an
   `includePastWork` flag. It has exactly three callers, verified: the two
   automatic ones in `tim-cli` — the marker directive (`cli.ts:485`) and the
   session directive (`cli.ts:571`), both of which a start hook shells out to —
   pass `false`, so a fresh session sees the project header, `── Open work ──`
   and the ACTION line and nothing else. The third, `previewSessionStart`
   (`checkpoint.ts:325`, reached only from `tim_preview_briefing`), passes
   `true`. The collectors (`previousSession`,
   `recentExchanges`, `latestCheckpoint`) and both render blocks in
   `briefingBlock` (`marker.ts:503-528`) **stay** — they are the machinery
   `tim_preview_briefing` and criterion 12 call deliberately. Deleting them here
   would mean rebuilding them for the on-demand path in the same release.
9. `── Recent Sessions ──` in `tim_load_project`'s output (`project-output.ts:628`)
   is untouched. That is a deliberate tool call, not an automatism.
10. A new skill `/tim-resume-topic <thema>` wraps `tim_resume_topic`. No CLI
    command — a surface with no consumer is ballast; it can follow if anyone
    misses it.
11. Session root tags stay structural. Only the Summary root aggregates content
    tags — a session root carrying every tag of its children would match every tag
    search and explain nothing.
12. A skill `/tim-continue` renders exactly the briefing that used to arrive
    automatically — previous session summary plus the not-yet-summarized raw
    turns — on demand. It wraps the existing `tim_preview_briefing`, which
    already builds that text and already creates no session and writes no
    marker. No new MCP tool. It must **not** wrap `tim_session_resume`: that
    tool aliases the running harness session onto the old session node
    (`session.ts:1014`) and throws once the current session has logged an
    exchange (`:996`), so it is a session merge, not a briefing.
13. Measurement, reported once after roughly a dozen sessions have run through the
    new prompt: the reuse rate, i.e. the share of assigned tags that already
    existed in the project vocabulary. Below ~50% the vocabulary is not being
    used; above ~95% the summarizer has stopped minting genuinely new topics.
    Either reading is the trigger to split tagging into its own pass — not before.

## Scope

- Repo: `~/projects/tim`
- Entry points: `packages/tim-summarizer/src/generate-summary.ts` (prompt),
  `packages/tim-store/src/session.ts` (`aggregateSessionTags`),
  `packages/tim-store/src/store.ts` (search),
  `packages/tim-mcp/src/server.ts` (search schema, new tool),
  `packages/tim-hooks/src/session-briefing.ts` (briefing reduction)
- TIM task: create one under P0063/Tasks
- **Depends on** `2026-08-11-handoff-note-home.md`: criterion 5 reads the note
  from the Summary root, which that spec creates.

## Non-goals

- No topic container nodes between the sessions root and the sessions, and no
  tool to move a session into one. Tags are many-to-many; containment is not.
- No retroactive re-tagging of the 9567 existing entries. `tim_tag_rename` exists
  and can merge vocabulary later, once criterion 1 has stabilized it. Note the
  caveat already flagged in `docs/hashtag-plan.md` section 6: `tim_tag_add` alone
  does **not** re-trigger `aggregateSessionTags`, so any later re-tag sweep has to
  call the aggregation itself or Summary roots stay stale.
- No controlled/closed tag vocabulary. The prompt hint plus normalization is the
  mechanism; a fixed enum is not.
- No vector or hybrid search in the topic path — FTS and exact tag match only.
- `resumeSession` is not removed and not renamed. It has never been used, which
  is the argument for not building `resumeTopic` as a second manual tool people
  ignore: criterion 8 makes topic recall the path that actually gets walked.
- **No derived/automatic handoff note.** Considered and rejected 2026-08-11: the
  summarizer sees only the exchange text, not the files the agent read or the
  uncertainty it carried. What it could derive descriptively, the rollup already
  says; what the note adds is judgment — measured versus assumed, parked, what
  not to do — and a guessed `next:` line is a risk with decoration, especially
  now that `tim_resume_topic` is the only path to the past. A session that dies
  without a handoff is covered by its raw turns, which are quotation rather than
  summary.
- No CLI command for topic resume (criterion 10).
- `/tim-continue` gets no topic argument and no session picker. It is the
  previous session, verbatim, on demand — `tim_resume_topic` is the path for
  anything older.

## Verification

- Prompt builder includes the full project vocabulary, and produces today's
  prompt verbatim when the vocabulary lookup returns nothing or throws.
- Aggregation, three fixtures: a one-batch and a two-batch session get their
  content tags on the Summary root; a three-batch session still drops tags that
  appear in only one of them. The two-batch case is the discriminating one — it
  fails under both the old rule and a naive "always >= 1".
- Tag-only search returns hits with no `query` given, ordered oldest-first, and
  respects `topK`. Mutation check: reversing the sort must fail the test.
- `tim_resume_topic` on a fixture with two sessions sharing a tag returns batch
  summaries from both, in session order, plus the newer session's handoff note
  and its raw turns.
- `tim_resume_topic` where the newest matched session has no note: the output
  names that session and says no note exists, and the older session's note does
  **not** appear anywhere in it. Mutation check: adding a fallback to the older
  note must fail this test.
- Briefing: with `includePastWork: false` the collector returns no
  previous-session summary and no raw exchanges, and still returns open work;
  with the flag set it returns both, so `/tim-continue` and
  `tim_preview_briefing` still render today's text. Mutation check: wiring the
  session-start caller to `true` must fail the first half.
- Full suite under the standing check:
  `mv tmp /tmp/tim-tmp-parked && env HOME=$(mktemp -d) npx vitest run`

## Interfaces & data (grill focus)

- `tim_search`: `query` becomes optional when `tag` is present; at least one of
  the two must be given. Zod schema and tool description both change.
- New store method for tag-only lookup. `search()` runs FTS on `options.query`
  first (`store.ts:2388`) and cannot answer a tagless query, so this is a new
  path — but a short one: `getRootLevelEntries` already matches a tag with
  `tags LIKE '%"#tag"%'` (`store.ts:1061-1064`), and that SQL shape carries over.
  Grill the result-set size at 9567 entries and whether an index is warranted.
- New MCP tool `tim_resume_topic(tag: string)`. One parameter, the tag. It binds
  nothing and mutates no session — pure read, unlike `tim_load_project`. No
  session count, no date floor until someone misses them.
- Vocabulary source: a project-scoped tag-frequency query is new.
  `stats().topTags` (`store.ts:3250-3274`) counts globally and returns only 20;
  the new query reuses its counting shape but scopes by project and returns all.
  It also finally answers how many distinct tags a project has — measure P0063
  once it exists.

## Risk

Criterion 8 removes the only *automatic* path to past work, so it must not land
before criteria 4, 5, 10 and 12 work — otherwise a fresh session starts blind.
DECIDED 2026-08-11: land them in one commit, **no config flag**. A flag that
defaults to the old behaviour never gets flipped. Criterion 8's `includePastWork`
is not that flag: it is a call parameter with one hard-coded value per caller,
not a setting anybody can turn back on.

Commit `17c6699` (raw unsummarized turns in the briefing, on
`feat/raw-tail-in-briefing`, unpushed, CI has never seen it) is merged **before**
this spec starts. Its reader is not deleted — criterion 7 moves it into
`tim_resume_topic`'s output, where it is worth more than in a cold start.
