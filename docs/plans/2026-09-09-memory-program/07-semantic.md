# feat(retrieval): discover semantic matches and refresh changed embeddings

Removed 2026-09-25. Search is full-text only. This plan is historical.

## What to build

Embedding search was meant to retrieve memories with no lexical overlap, merge those hits with lexical candidates, and refresh the index when content changed.

## Blocked by

- https://github.com/ZF-IT-Automation/tim/issues/32

## Seam

Store and public MCP retrieval using deterministic embedding provider; embedding refresh hook.

## Acceptance criteria

- [ ] Independent embedding candidates are scoped and filtered before result limits, then deduplicated with lexical candidates.
- [ ] Content edits invalidate/requeue embeddings; model identity and dimensions are enforced.
- [ ] Reuse model initialization; explicit disabled/unavailable provider has documented deterministic behavior.
- [ ] Tests inject deterministic embeddings to demonstrate no-overlap recall, model mismatch exclusion and changed-content reindexing.
- [ ] Document limits and an opt-in real local model check without asserting mocked quality as real-model evidence.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent
