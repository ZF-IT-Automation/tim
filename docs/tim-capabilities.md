# TIM capabilities and boundaries

Status: public beta. This page describes the current product, not a historical vision. See the [README](../README.md) for setup and comparisons, the [CLI reference](tim-cli-reference.md) for commands, and [GitHub Issues](https://github.com/Bumblebiber/tim/issues) for implementation status.

## What TIM is for

TIM provides a persistent, local-first memory service for agents working across sessions and projects. Its main value is continuity: recover the decisions, constraints, failures and unfinished work behind a codebase instead of reconstructing them from scratch.

SQLite is the local system of record. MCP exposes agent-facing tools. The CLI provides setup, diagnostics, import/export and recovery. Hooks capture exchanges where the host integration supports them. A separately configured model chain produces summaries.

## Implemented feature groups

| Group | Capabilities | Practical boundary |
|---|---|---|
| Project knowledge | Project roots, structured sections, explicit binding, labels and aliases; rules, decisions and codebase notes. | Structure helps organization; it does not verify the truth of a note. |
| Work tracking | Tasks, nested status/priority metadata, bugs, ideas, ordering and commit links. | This is memory around work, not a replacement for a team's issue tracker. |
| Sessions | Exchange logging, batch summaries, rollups, checkpoints, handoff, session resume and topic recall. | Automatic capture depends on host hooks. Summarizer availability and quality depend on the configured chain. |
| Briefing | Project loading, section/depth controls, summary-first reads and briefing preview. | Budget and priority behavior are being strengthened in [#34](https://github.com/Bumblebiber/tim/issues/34). |
| Retrieval | SQLite FTS5, scoped search options, tags, optional embedding-assisted ranking and associative recall through a CLI model chain. | Independent semantic discovery, filter ordering and vector freshness are tracked in [#32](https://github.com/Bumblebiber/tim/issues/32) and [#33](https://github.com/Bumblebiber/tim/issues/33). |
| Relationships | Explicit edges and tracing, including relationships between decisions, tasks and commits. | An edge records an assertion, not proof of causality. |
| Trust signals | Verification timestamps, staleness annotations and best-effort Git provenance. | Missing warnings do not prove that a memory is current. Git provenance is context, not source evidence or access control. |
| Negative memory | Guard lookup for recorded failures/learnings, suppression and reversible irrelevant flags. | A clear guard result means no matching recorded warning, not permission to proceed. |
| Curation | Duplicate discovery, structural inspection, import audit, moves, tags and bulk operations. | Preview and back up before material restructuring. |
| Operations | Doctor, health and error statistics, local viewer, SQLite snapshots and restore. | Verify recovery on an isolated copy. Temporary snapshot storage is not durable backup. |
| Portability | hmem import/export and optional encrypted device sync. | Export policy and encryption are separate concerns; inspect secret-marked subtrees before sharing. |

## Storage and privacy

The local store and FTS retrieval do not require a hosted TIM account or remote vector database. Raw recorded exchanges remain available alongside derived summaries; summaries are lossy and should not replace source inspection.

Optional operations have different data flows:

- A configured summarizer or associative-recall CLI can send memory to its model provider.
- Embedding behavior depends on the configured provider and model. Local vectors are derived indexes, not portable source records.
- Sync sends encrypted envelopes to the configured service. The ordinary sync key and the additional secret passphrase represent distinct boundaries.
- Usage feedback is device-local ranking telemetry; it is not evidence that users on another device found an entry useful.

Secret-boundary enforcement and delete ordering are under active verification in [#28](https://github.com/Bumblebiber/tim/issues/28) and [#27](https://github.com/Bumblebiber/tim/issues/27). Do not infer production readiness from the existence of an encryption feature.

## Public surfaces

Use MCP tools for project binding, reads/search, writes/updates, sessions, relationships and curation. Use the CLI for installation, host setup, operational diagnostics and recovery. Tool schemas and command help are the authoritative parameter reference; this page deliberately avoids a hard-coded tool count.

Common entry points:

- `tim_load_project`: bind and load project context; use `bind:false` for a non-binding lookup.
- `tim_search`, `tim_read`, `tim_remember`: find candidates, inspect entries, or request associative recall.
- `tim_write`, `tim_update`, `tim_write_many`: record durable knowledge and maintain existing entries.
- `tim_resume_list`, `tim_session_resume`, `tim_resume_topic`: recover previous work.
- `tim_guard`, `tim_verify`, `tim_health`: surface known risks and maintain memory quality.

Connect through supported host setup for Claude Code, Codex, Cursor or Hermes, or configure an MCP client manually. An MCP connection alone does not install capture hooks.

## Architecture

| Package | Responsibility |
|---|---|
| `tim-core` | Shared types, configuration and foundational contracts. |
| `tim-store` | SQLite persistence, retrieval and project/session operations. |
| `tim-mcp` | Agent-facing protocol and presentation. |
| `tim-cli` | Setup and operational commands. |
| `tim-hooks` | Host lifecycle integration and background trigger logic. |
| `tim-summarizer` | Summary processing and configured worker chains. |
| `tim-sync-client` | Client-side sync, encryption and retry handling. |
| `tim-sync-server` | Optional sync service. |
| `tim-migrate` | Import/export and migration workflows. |
| `tim-skills` | Packaged host guidance. |

## Verification and current improvement program

Tests, build checks and type checking are useful evidence, not proof of summary quality, disaster recovery or deployment safety. Run verification in an isolated checkout: `npm test`, `npm run lint`, and `npm run test:build-pipeline`. Installation and the build-pipeline test clean generated output; do not run them against a live installation.

The [September 2026 improvement program](plans/2026-09-09-memory-program/README.md) tracks correctness fixes, evidence sources and authority, temporal validity, task-aware briefing, coverage diagnostics and bilingual retrieval evaluation. Features in that plan are not implied to be shipped by their inclusion here. A synthetic retrieval benchmark measures retrieval behavior, not real-world agent task success.

For migration, follow the [hmem runbook](hmem-to-tim-migration.md). For safe operational commands, consult the [CLI reference](tim-cli-reference.md). Historical design documents and old test counts are not a current capability contract.
