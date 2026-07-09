# GitHub Branch Protection

TIM beta uses `master` as the protected integration branch.

Rules:
- Require pull request before merging.
- Require status checks to pass before merging.
- Require the CI workflow job for build/tests.
- Block force pushes.
- Block deletions.
- Allow admins to bypass only for emergency release repair.

Recommended command:

```bash
gh api -X PUT repos/Bumblebiber/tim/branches/master/protection \
  -H "Accept: application/vnd.github+json" \
  --input docs/github-branch-protection.payload.json
```

Current blocker:
- GitHub currently rejects branch protection for this private repo with `HTTP 403`:
  `Upgrade to GitHub Pro or make this repository public to enable this feature.`
- Apply the payload after either upgrading the owning account/organization or making
  the repo public.
- The required status check context in the payload is `build-test`, matching the
  current GitHub Actions job name.
