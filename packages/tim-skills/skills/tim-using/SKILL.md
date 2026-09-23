---
name: tim-using
description: When to write, read, or search TIM — one example each.
---

# tim-using

| Goal | Tool | Example |
|------|------|---------|
| Save new fact/task/idea | `tim_write` | `tim_write({ where: "P0063/Ideas", title: "Cache layer", content: "...", tags: ["#tim"] })` |
| Known label/id, need body | `tim_read` | `tim_read({ id: "P0063" })` or `tim_read({ id: "L0042", depth: 2 })` |
| Keyword lookup | `tim_search` | `tim_search({ query: "sqlite WAL", topK: 10 })` |

Rules:
- `tim_write` = create only. Edit → `tim_update` (read first, merge, then update).
- `duplicate_suspected` → read candidate, extend via `tim_update`, don't `force:true` blindly.
- Topic tags only (#tim). Status/priority → `metadata.task`.

## Writing so the session-start brief stays useful

Every entry you write is read later as a one-line preview by an agent that knows nothing else.
The brief can only be as good as these entries.

- **Title** ≤ 80 chars, names the subject. Status/severity go in `metadata.task`/metadata, never in the title — the renderer prints them.
- **First body line is the conclusion.** Previews show ~500 chars; reasoning comes after.
- **One language per project** — the language of its Overview. Don't switch mid-project.
- **Put it in an existing section** (`where: "P0063/Bugs"`, `/Decisions`, `/Log`, `/Ideas`). Never create new direct children of the project root.
- **Decisions** = the choice + the alternative that lost + why. **Log** = one dated entry per finished piece of work, not per step.
- **Keep state where it lives.** Finishing a task → set its status now. The Overview's `State` line changes → update it now.
- **A failed write is not done.** If a TIM call fails (e.g. `Transport closed`), retry, or tell the user it is unsaved. Do not park memory in repo files like `HANDOFF.md` — the next brief cannot see them.
