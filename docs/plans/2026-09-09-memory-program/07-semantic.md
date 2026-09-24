# feat(retrieval): discover semantic matches and refresh changed embeddings

## What to build

Vector search can retrieve memories with no lexical overlap, hybrid merges independent lexical and semantic candidates, and indexed meaning tracks edited content.

## Blocked by

- https://github.com/ZF-IT-Automation/tim/issues/32

## Seam

Store and public MCP retrieval using deterministic embedding provider; embedding refresh hook.

## Acceptance criteria

- [ ] Independent vector candidates are scoped and filtered before result limits, then deduplicated with lexical candidates in hybrid mode.
- [ ] Content edits invalidate/requeue vectors; model identity and dimensions are enforced.
- [ ] Reuse model initialization; explicit disabled/unavailable provider has documented deterministic behavior.
- [ ] Tests inject deterministic vectors to demonstrate no-overlap recall, model mismatch exclusion and changed-content reindexing.
- [ ] Document limits and an opt-in real local model check without asserting mocked quality as real-model evidence.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent
