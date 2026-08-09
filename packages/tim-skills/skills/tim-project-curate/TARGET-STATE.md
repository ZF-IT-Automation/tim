# Target state of a curated TIM project

The invariants a curated project tree satisfies. They are checkable, not
aspirational — if you cannot check one, say so rather than assuming it passes.

Source of truth for section names and kinds:
`tim-core/src/project-schema.ts` (`PROJECT_SCHEMA`) and
`tim-core/src/schema-kinds.ts` (`SCHEMA_KINDS`).

## Project root

- **R1** The root carries `metadata.kind: "project"` and `metadata.label`.
- **R2** Every direct child of the root is a section: either `metadata.kind: "section"`
  with a title from `PROJECT_SCHEMA`, or one of the managed roots `sessions-root` /
  `commits-root`.
- **R3** No loose direct children. Content nodes, session summaries, notes and import
  leftovers belong in a section, not under the root.
- **R4** Exactly one node per managed kind: one `sessions-root`, one `commits-root`.
- **R5** At most one section per canonical title.
- **R6** Managed sections are identified by `metadata.kind`, never by title. A node
  titled "Sessions" or "Commits" carrying `kind: "section"` is a duplicate of the
  managed root, no matter how plausible its body reads. Two identity rules for one
  node is what generates duplicates in the first place.
- **R7** A section whose title is a sentence (`Goal: …`, `Audience: …`,
  `Deployment: …`) is an hmem import artifact, not a section. Its content belongs in
  Overview or Context.

## Sessions subtree

- **S1** The shape is `sessions-root → session → {Summary, Exchanges} → exchange-batch
  → exchange`, with kinds `session`, `session-summary-root`, `exchanges-root`,
  `exchange-batch`, `exchange`.
- **S2** An `exchange-batch` with no children is legal **only as the last batch** of
  its `Exchanges` node — that is the open batch the logger appends to next, and
  `deriveCounters` already skips it.
- **S3** An empty batch with siblings after it is missing content, not a stub.
  Investigate it. Never delete it — the gap is the evidence.
- **S4** Session summaries live under their session. A `#session-summary` node
  directly under the project root is an import leftover (see R3).

## Content

- **C1** Structural nodes (`SCHEMA_KINDS`) may have an empty body. They are
  containers; emptiness is their normal state, and "many empty nodes" in a viewer is
  usually this rather than data loss.
- **C2** Every non-structural node has either a body or children. One with neither is
  a stub: fill it, or delete it.
- **C3** No duplicate content. Two nodes covering the same thing get merged into the
  older one (it holds the inbound edges); the newer one is deleted.

## Why a project drifts out of this state

Knowing the mechanisms tells you which deviations to expect:

- **Mass `irrelevant` flags produce duplicate roots.** The managed-root lookup
  (`getChildByKind`) filters `irrelevant = 0`. Any event that flags a project's
  children invisible — a migration, a bad bulk update — makes the lookup miss the
  existing root and create a second one. Repairing the flag afterwards leaves both.
- **Title-identified repair produces duplicate sections.** Anything that creates
  `Sessions`/`Commits` by title sits next to the kind-identified managed root (R6).
- **Session start writes the skeleton before any content exists.** `Summary`,
  `Exchanges` and `Batch 1` are written when the session opens. A session whose
  logging hook never fires leaves that skeleton behind: an empty trailing batch (S2)
  and a session that logged nothing. Count trailing versus interior empty batches
  before reaping anything — only all-trailing is safe, and even then an empty session
  still records that a session happened, so ask.
- **hmem imports land content at root level.** Session summaries and sentence-titled
  pseudo-sections (R3, R7) are the signature.
