# feat(memory): retain superseded decisions and support as-of recall

## What to build

Users can explicitly supersede a decision while keeping historical evidence. Current retrieval favors valid knowledge; historical queries can reconstruct earlier decisions and expose unresolved contradictions.

## Blocked by

- https://github.com/ZF-IT-Automation/tim/issues/35
- https://github.com/ZF-IT-Automation/tim/issues/32

## Seam

Public update/link/read/search behavior against a project history.

## Acceptance criteria

- [ ] Document additive validity/supersession metadata and expose an explicit validated operation on existing update/link surfaces.
- [ ] Reject cycles, invalid dates and incompatible cross-project supersession; changing temporal state must be atomic.
- [ ] Current read/search distinguish superseded from current records; optional asOf search returns records valid at the requested time.
- [ ] Historical bodies remain available; preserve existing explicit contradicts links and report conflicts without automatic truth rewriting.
- [ ] Integration tests cover create old decision, supersede, current recall, historical recall and invalid rollback.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent
