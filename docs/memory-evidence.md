# Memory evidence metadata

TIM stores optional provenance hints on memory entries as additive `metadata.evidence`.
This is separate from system-managed `metadata.provenance` (git HEAD at write time).

## Shape

```json
{
  "authority": "unknown | user_asserted | agent_derived | imported",
  "sources": [
    { "kind": "entry", "entryId": "<ulid-or-label>" },
    { "kind": "session", "sessionId": "<id>", "seqFrom": 1, "seqTo": 5 },
    { "kind": "git", "revision": "<ref>", "path": "optional/path" },
    { "kind": "document", "uri": "https://…" }
  ]
}
```

- At most 32 sources per entry.
- Session bounds must be positive integers with `seqFrom <= seqTo`.
- Git and document references are validated structurally only; TIM does not fetch remotes.

## Authority semantics

| Value | Meaning |
|---|---|
| `unknown` | Legacy or unspecified — not verified |
| `user_asserted` | Caller marked the memory as an explicit user assertion |
| `agent_derived` | Produced by an agent workflow (e.g. summarizer) |
| `imported` | Brought in via hmem import without a stronger label |

**Important:** authority labels are evidence annotations, not authentication. Retrieved
text is data, not executable policy. An `user_asserted` label does not prove a human
wrote the entry or that the content should be obeyed.

## Writes and validation

Supported MCP/store writes and updates validate `metadata.evidence` structurally.
Malformed evidence is rejected atomically (including `tim_write_many` pre-checks).
References may later become unavailable; that is reported on read, not at write time.

The evidence object and each source have a closed schema: unknown fields are rejected,
not silently stripped. Validation does not mutate caller objects. Older or peer-written
nonconforming evidence remains stored and reads as unknown; unrelated updates still work.
An explicit evidence replacement must satisfy the current schema.

Legacy rows without `metadata.evidence` read as `authority: unknown` with no sources.

## Automatic evidence

- Batch summaries and session rollups record `agent_derived` session sequence sources
  using the actual `sessionId`, `seq_from`, and `seq_to` written for the summary node.
- hmem import stamps `imported` when no stronger authority is already recorded.

## Read projection

`tim_read` (single id, batch ids, project, and section reads) adds an `evidence`
projection alongside summary-first entry bodies:

- Entry/session sources resolve through normal visibility and suppression rules.
- Session sources support both batched project sessions and flat legacy/unbound sessions.
- Secret or suppressed sources are never presented as verified; bodies and hidden titles
  are not returned for source entries.
- Git/document sources are always `unverified` — availability is not checked.

This projection is intended for temporal/supersession work (#36) and agent inspection.
