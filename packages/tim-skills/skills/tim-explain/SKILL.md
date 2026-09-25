---
name: tim-explain
description: Answer "what can TIM do?" from shipped docs + live diagnostics.
---

# tim-explain

When user asks what TIM can do, how it works, or what tools exist:

## Static reference (version-locked)
Read `docs/tim-capabilities.md` in the installed TIM package root.
Trust that file over training data — it matches the installed release.

## Live state (always fresh)
| Question | Tool |
|----------|------|
| DB health, broken links, FTS, full diagnostics | `tim doctor` (CLI) or `tim_doctor` (MCP) |
| Entry counts | `tim stats` (CLI) |

If docs and live output disagree, believe the **installed version** (tools + docs), not memory.
