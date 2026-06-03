# Plan: Summarizer Hashtags + Untagged Detection (CAVEMAN)

Goal: batch summary get 3-5 content tags. Session aggregate tags. New tool find untagged batch.

1. **generate-summary.ts** — `buildPrompt` add last line ask: `TAGS: #a #b ...` (3-5, lowercase kebab, # prefix). Add pure `extractTags(text)→{body,tags}`: strip TAGS line, normalize, dedup, slice 5. No-chain path = FALLBACK_MARKER → empty tags (that the seam, not heuristic).
2. **summarize.ts loop** — after `generateSummary`, `extractTags` → store `body` as summary, pass `tags` to `tim_write_batch_summary`.
3. **session.ts `writeBatchSummary`** — add `tags?: string[]` param. Node tags = `[#session-summary,#batch-summary,...tags]`. AFTER write: recompute session aggregate (read all sibling KIND_BATCH content-tags, exclude 2 structural, freq>=2) → `update` Summary node tags. Expose `aggregateSessionTags(sessionId)` standalone (re-tag path reuses).
4. **session.ts `showUntagged()`** — mirror `showAllUnsummarized`: `getByMetadataKind(KIND_SESSION,100)` → Summary→KIND_BATCH children where `tags \ {#session-summary,#batch-summary}` empty. Return `{sessionId,batchNodeId,batchIndex,title,seqFrom,seqTo}[]`.
5. **server.ts** — `tim_write_batch_summary` schema +`tags?:string[]`; pass thru. New READ tool `tim_show_untagged` (no params) → `showUntagged()`. mcp-client + UnsummarizedBatch types unchanged.
6. **Re-tag existing** — `tim_show_untagged` + existing `tim_tag_add`, then `aggregateSessionTags`. (tag_add alone NOT re-trigger aggregate — flagged.)

Decisions: parse-in-loop (generateSummary stays string). writeBatchSummary idempotent → tags land first write only. Aggregation store-side (loop is MCP-only, no store). Out of scope: project-tag rollup, project-output display.

Tests: extractTags unit; writeBatchSummary tags+aggregate; showUntagged structural-filter; MCP schema. `npx tsc -b && npx vitest run`.
