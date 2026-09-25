# Task-aware bounded project briefings

GitHub [#34](https://github.com/ZF-IT-Automation/tim/issues/34). This document describes the additive MCP interfaces and how rendered briefing output is bounded. Token counts here are **approximate** — TIM uses a conservative UTF-8-byte heuristic, not an exact model tokenizer.

## Surfaces

Both tools accept the same optional parameters:

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `tokenBudget` | integer 1–64000 | **12288** (12 KB) when omitted | Bounds the **rendered MCP text** for `tim_load_project` and `tim_preview_briefing` |
| `query` | string | none | Adds project-scoped task context extras |
| `ftsQueryMode` | `literal` \| `or-terms` | `literal` | Passed through to scoped FTS for `query` |

`tim_preview_briefing` still accepts deprecated `maxTokens` as an alias for `tokenBudget` (including historical `maxTokens: 0` to omit directive briefing content).

### `tim_load_project`

- Default rendered brief is bounded to **12 KB** (`briefing.maxTokens`, default 12288).
- With a briefing context (normal bind/load path), **Tasks** and **Overview** appear as index lines in the Sections block; their bodies are omitted because the **Now** block and Overview preview carry the essentials. Other sections render bodies under their headings.
- Explicit `sections: ["Tasks"]` (or any named section) always renders that section's body even in load mode.
- `budget` (existing) still limits how many child entries `loadProject` reads from the store; it is independent of `tokenBudget`.

Cross-project lookup is `tim_load_project` with `bind: false`. That call uses the same load layout and the same default **12 KB** budget, and it does not bind the session. The former `tim_read_project` tool (read-mode section bodies) is no longer registered.

### `tim_preview_briefing`

- Uses the same `tokenBudget` validation and default as load.
- Uses the same block priority selection and whole-response bounding as load (directive, briefing, query extras).
- Does **not** bind the session or write markers — preview remains read-only.

## Session-start hook budget

The session-start hook directive uses a **fixed 1024-unit budget** (~4 KB, G9). This is **not** controlled by `briefing.maxTokens` in config — that key bounds MCP project brief output only.

## Priority and budgeting

Rendered output is assembled as priority-ordered blocks, then packed into `tokenBudget`:

1. **Header** — project label, meta, description, project summary (head-clamped when long)
2. **Now** — handoff note + top open tasks (load only, protected from trimming)
3. **Active rules** — Rules section content
4. **Recent session / handoff** — Recent Sessions block (newest substantive summaries)
5. **General sections** — Decisions, Ideas, Bugs, etc. (section heading + body)
6. **Task query extras** — only when `query` is set
7. **Log** — lowest priority; at most three preview lines plus an explicit omission marker

Reserved tiers (1–4) are allocated before Log volume can consume the budget.

When the budget is exhausted, omitted blocks are listed in a trailing `… briefing omissions:` line.

## Token estimation

```text
estimatedTokens = utf8ByteLength
```

Each UTF-8 byte consumes one budget unit. Unicode code points are never split.

## Validation errors

`tokenBudget` must be a finite **integer** in `1..64000`. Zero, negative, NaN, non-integer, and over-limit values return `isError: true` from MCP handlers. Invalid configured `briefing.maxTokens` values are clamped to 12288.

## Limitations

- Approximate token counts only; no model-specific tokenizer.
- Query extras use FTS (`searchType: fts`); semantic/vector modes are not used for briefing selection.
- Very small `tokenBudget` values may retain only header fragments plus omission markers.
- Entry-level `budget` truncation during `loadProject` can still occur before rendering; increase `budget` when drilling deep trees.

## Quality benchmark hook (#38)

Benchmark scenarios should call these tools with explicit `tokenBudget` and optional `query`, then measure rendered UTF-8 byte size and check expected strings (rules, urgent tasks, session handoff, query needles) against fixture gold labels.
