# feat(health): report memory coverage and actionable backlog

## What to build

Doctor and memory health show whether conversations were logged, summarized and embedded, not just whether the server is reachable.

## Blocked by

- GitHub #30
- https://github.com/Bumblebiber/tim/issues/33

## Seam

CLI doctor and MCP health responses from temporary fixtures.

## Acceptance criteria

- [ ] Report observed exchange count, actual covered/pending ranges, latest successful summary/rollup, unembedded count and available sync status.
- [ ] Explicitly distinguish zero work, disabled features, unknown telemetry and failure; never claim health from absence of evidence.
- [ ] Expose through existing CLI doctor and MCP health/doctor with compatible additive structured fields and useful guidance.
- [ ] Reuse actual partial-batch coverage; no production mutation or accidental model generation during health reads.
- [ ] Tests verify unsummarized partial sessions, edited embedding backlog and disabled/offline sync.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent
