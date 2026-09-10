# Task-aware bounded project briefings

GitHub [#34](https://github.com/Bumblebiber/tim/issues/34). This document describes the additive MCP interfaces and how rendered briefing output is bounded. Token counts here are **approximate** — TIM uses a conservative UTF-8-byte heuristic, not an exact model tokenizer.

## Surfaces

Both tools accept the same optional parameters:

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `tokenBudget` | integer 1–64000 | `briefing.maxTokens` from config (9000 when unset/invalid) | Bounds the **rendered MCP text** |
| `query` | string | none | Adds project-scoped task context extras |
| `ftsQueryMode` | `literal` \| `or-terms` | `literal` | Passed through to scoped FTS for `query` |

Legacy callers that omit `query` keep the previous brief shape (no `── Task context ──` block). `tim_preview_briefing` still accepts deprecated `maxTokens` as an alias for `tokenBudget` (including historical `maxTokens: 0` to omit directive briefing content).

### `tim_load_project` / `tim_read_project`

- `tokenBudget` applies to the formatted project brief returned by the tool (including footer, omission markers, and NEXT hint on binding loads).
- `budget` (existing) still limits how many child entries `loadProject` reads from the store; it is independent of `tokenBudget`. Reserved sections (sessions, rules, tasks, general) are loaded before Log volume when no explicit `sections` filter is set.
- `query` triggers a project-scoped FTS pass; hits are rendered in a `── Task context ──` block. Suppressed entries and other projects are excluded.

### `tim_preview_briefing`

- Uses the same `tokenBudget` validation and default as load.
- Uses the same block priority selection and whole-response bounding as load (directive, briefing, query extras).
- Does **not** bind the session or write markers — preview remains read-only.

## Priority and budgeting

Rendered output is assembled as priority-ordered blocks, then packed into `tokenBudget`:

1. **Header** — project label, meta, description, project summary
2. **Active rules** — Rules section and `#rule` / `metadata.type=rule` entries
3. **Urgent open tasks** — Tasks section (open tasks sorted by status/priority/order)
4. **Recent session / handoff** — Recent Sessions block (newest summaries)
5. **General sections** — Decisions, Ideas, Bugs, etc.
6. **Task query extras** — only when `query` is set
7. **Log** — lowest priority; at most three preview lines plus an explicit `… N log entries omitted (token budget)` marker

Reserved tiers (1–4) are allocated before Log volume can consume the budget. Entry loading also fetches reserved sections before Log so a huge early Log tree cannot starve later rules, tasks, or sessions under normal defaults.

When the budget is exhausted, omitted blocks are listed in a trailing `… briefing omissions:` line. A final safety clamp may append `… [briefing truncated to token budget]`.

## Token estimation

```text
estimatedTokens = utf8ByteLength
```

Each UTF-8 byte consumes one budget unit. This is deliberately conservative for byte-based model tokenizers, not an exact token count; TIM does not assume four bytes fit into one token. The budget covers rendered text only, not protocol envelopes or model-specific special tokens. Unicode code points are never split. At budgets below three units, ASCII dots indicate truncation because a Unicode ellipsis needs three bytes.

## Validation errors

`tokenBudget` must be a finite **integer** in `1..64000`. Zero, negative, NaN, non-integer, and over-limit values return `isError: true` from MCP handlers. The configured default (`briefing.maxTokens`, typically 9000) is valid when passed explicitly; invalid configured values are clamped to 9000.

## Limitations

- Approximate token counts only; no model-specific tokenizer.
- Query extras use FTS (`searchType: fts`); semantic/vector modes are not used for briefing selection.
- Very small `tokenBudget` values may retain only header fragments plus omission markers.
- Entry-level `budget` truncation during `loadProject` can still occur before rendering; increase `budget` when drilling deep trees.

## Quality benchmark hook (#38)

Benchmark scenarios should call these tools with explicit `tokenBudget` and optional `query`, then measure rendered UTF-8 byte size and check expected strings (rules, urgent tasks, session handoff, query needles) against fixture gold labels.
