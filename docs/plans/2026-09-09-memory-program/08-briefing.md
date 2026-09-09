# feat(briefing): prioritize current work within task-aware context budgets

## What to build

A project briefing always prioritizes active rules, open work and recent handoff over old log volume, and optionally selects extra context for the current task within a bounded output budget.

## Blocked by

- https://github.com/Bumblebiber/tim/issues/32
- GitHub #31

## Seam

Rendered project-load and briefing-preview MCP responses.

## Acceptance criteria

- [ ] An early section with 201 entries cannot displace all urgent tasks and latest session from a normal default briefing.
- [ ] Optional task query and token budget are exposed through existing briefing/load surface with documented defaults and validation.
- [ ] Deterministic reserved priorities and bounded rendered text, including Unicode and tiny-budget behavior; omissions/truncation are explicit.
- [ ] Task-relevant extras are project-scoped and do not override active rules or leak suppressed entries.
- [ ] Regression tests exercise complete rendered MCP/preview output, not only an unconsumed helper.

## Constraints

Keep Node.js 22 compatibility and existing public defaults unless the acceptance criteria explicitly change them. Use existing packages and metadata before adding dependencies or schema. Preserve original exchanges. No production database maintenance, credential changes, hosted deployment, or unrelated refactors. Add tests at the stated seam. Implement in an isolated full clone, then commit and report verification for independent integration review.

**Status:** ready-for-agent
