---
name: tim-secret-audit
description: Verify secret-marked TIM subtrees before sharing, sync, export, or collaborator access.
---

# tim-secret-audit

Use before sharing, `tim_export`, sync setup, or adding collaborators.

Checks:
1. Identify sensitive roots: entries with `metadata.secret` or known private
   projects/sections.
2. Use `tim_secret` helpers if available; otherwise `tim_read` suspected roots
   and inspect metadata only as far as needed.
3. Verify moved children inherited secret metadata.
4. Confirm export/sync scope excludes private material, or get user approval.

Do:
- prefer marking an entire subtree secret
- document which root caused the protection
- run `tim_doctor` after bulk moves

Do not paste secrets into chat, release notes, issues, or test fixtures.
