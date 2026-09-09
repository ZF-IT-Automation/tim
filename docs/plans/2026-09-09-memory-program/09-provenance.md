# feat(memory): expose evidence sources and preserve memory authority

## What to build

Agents and users can inspect where a memory came from and distinguish imported content, agent-derived claims and explicit user assertions without treating retrieved text as executable policy.

## Blocked by

- GitHub #31

## Seam

Write/import/summary creation through read evidence projection; temporary data only.

## Acceptance criteria

- [ ] Use documented additive metadata for sources (entry/session sequence, git revision or document reference) and authority; legacy records are explicitly unknown/unverified.
- [ ] Supported writes validate evidence references; summaries record their actual session/sequence source automatically.
- [ ] Read responses expose source references and unavailable/stale source status while respecting suppression and secret visibility.
- [ ] Imported/agent-derived memories retain their authority on retrieval; no implicit promotion to user-confirmed rules.
- [ ] Document that authority annotations are evidence labels, not an authentication mechanism; demonstrate complete write/summary-to-read flows.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent

