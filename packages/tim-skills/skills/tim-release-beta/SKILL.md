---
name: tim-release-beta
description: Pre-release checklist for TIM beta tags and package smoke tests.
---

# tim-release-beta

Use before a TIM beta tag/release.

Gate:
1. `git status --short --branch` — no surprise work.
2. `npm run build`
3. `npm test` or explain exact external blocker.
4. `npm pack --dry-run --workspaces`; confirm no tests/cache/private files.
5. `tim snapshot` before testing migration flows against a live DB.

Smoke:
- install tarball/temp checkout
- `tim --help`, `tim init`, `tim doctor`
- start MCP and call `tim_doctor`
- run hmem dry-run import if migration changed

Release:
- write beta notes: risk, known issues, rollback
- `git tag vX.Y.Z-beta.N`
- push commit + tag only after checks are reported.
