---
name: tim-tag-inventory
description: Audit one project's tag vocabulary and merge the families that name one subject twice.
---

# tim-tag-inventory

Tags are how `tim_resume_topic` and `tim_search({ tag })` find past work, so a split
vocabulary costs retrieval, not tidiness. Run this per project, when asked or when a
project is old enough to have drifted. One project at a time. Never use direct SQL.

`tim_stats({ root: label, tags: true })` gives the histogram plus `distinct` and
`usedOnce`. Read the shape first: a healthy project has few singletons, a drifted one
is mostly singletons and holds several names for one subject.

Three patterns, and only two of them are drift:

- **Respellings and near-synonyms** — `#bugfix` / `#bugfixing` / `#bug-fixing`,
  `#taskmanagement` / `#task-management`. Always drift. Merge.
- **One subject at two widths** — `#handoff` beside `#handoff-note`, `#schema` beside
  `#schema-migrations`. Merge into what the entries actually mean, usually the
  narrower, and say which you chose.
- **Distinct siblings sharing a head word** — `#tim-mcp` / `#tim-hooks` / `#tim-store`
  are packages, `#session-continuity` / `#session-start` / `#session-recovery` are
  different subjects. **Leave alone.**

Nothing mechanical separates the third from the first two — that is why this needs a
reader. Co-occurrence was measured as a discriminator and had none: two given tags
almost never share an entry, drift or not. So read two or three entries carrying each
member (`tim_search({ tag })`) before proposing anything. A merge you cannot justify
from the bodies is a merge you should not make.

Per family:

1. Propose it with counts per member and the winning name. Never merge unasked — this
   rewrites how the history can be found.
2. `tim_tag_rename({ oldTag, newTag, project: label })`. **Always pass `project`.**
   Without it the rename hits every project, and one word means different things in
   different trees: `#handoff` was the worker handoff in one and the handoff note in
   another.
3. Write the merge and its reason into the project's Log. The next curator has to know
   a name was retired, or it comes back.

Do not chase singletons as such. A one-off tag naming a real subject is fine; it is
waste only when it restates a tag that already exists.

Close by re-reading `tim_stats({ root: label, tags: true })` and reporting `distinct`
and `usedOnce` before and after, plus every family you deliberately left intact.
