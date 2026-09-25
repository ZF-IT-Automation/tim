---
name: tim-remember
description: remember vs search vs read — when to use which.
---

# tim-remember

| Situation | Tool | Why |
|-----------|------|-----|
| Know exact id/label | `tim_read` | Direct hit, no ranking noise |
| Know keywords | `tim_search` | FTS5, fast, precise terms |
| Vague / "we discussed X last week" | `tim_search` or `tim_resume_topic` | Broaden the words, or name the topic |

Examples:
- "What's in P0063 Tasks?" → `tim_read({ id: "P0063/Tasks" })` or `tim_show({ what: "tasks", root: "P0063" })`
- "Find entries about sync passphrase" → `tim_search({ query: "sync passphrase" })`
- "Remember when rmapi failed?" → `tim_search({ query: "rmapi upload failed" })` or `tim_resume_topic({ topic: "rmapi upload" })`

Before a risky action, `tim_search` recorded errors and learnings for that action. No hit is not permission to proceed.
