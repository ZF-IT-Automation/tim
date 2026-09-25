# fix(retrieval): apply scope before limits and honor search modes

## What to build

Scoped search and prompt recall find relevant memories even when unrelated projects dominate the global corpus. Explicit search-mode selection reaches the actual retrieval implementation. Search is full-text only as of 2026-09-25.

## Blocked by

None — can start immediately.

## Seam

MCP search calls and prompt-submit output over temporary stores.

## Acceptance criteria

- [ ] Project, type, tag and status filters apply before candidate limits and ranking; nested task/bug status is resolved consistently.
- [ ] Prompt recall finds its project match despite at least twelve higher-ranked foreign matches; no cross-project leakage.
- [ ] MCP searchType is passed through and explicit FTS never initializes embeddings.
- [ ] Natural-language prompt extraction supports German and English without requiring every function word to match; exact search semantics remain available.
- [ ] Integration regressions cover public MCP search plus prompt hook.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent

