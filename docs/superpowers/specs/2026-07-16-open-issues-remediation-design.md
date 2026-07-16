# Open Issues Remediation Design

**Date:** 2026-07-16
**Branch:** `fix/open-issues`
**Scope:** GitHub issues #3–#8 plus the P8001 stale-marker and `bind:false` side effects.

## Goal

Close the six current GitHub issues and eliminate the marker corruption that bound this repository to the temporary test project P8001. Preserve existing public behavior unless an issue explicitly identifies that behavior as broken or unsafe.

## Delivery model

Work happens in isolated worktrees. Three independent tracks run first: marker safety, Inbox repair, and bounded search. Changes are reviewed and integrated individually. Installer, CLI cleanup, and Claude hook work then run serially because they share `tim-cli`, hook scripts, and setup configuration.

Every behavior change follows red-green-refactor. Each track receives a specification review and a code-quality review before integration. The integration branch runs package tests after every merge and the complete workspace build/test/lint after all tracks land.

## 1. Marker safety and P8001

### Root cause

Stdio MCP integration tests use a temporary database but let child servers inherit the repository working directory. A test creates P8001 in its temporary database, loads it, and `tim_load_project` writes P8001 into the repository `.tim-project`. The temporary database is deleted, leaving an invalid marker. Marker synchronization also currently runs for `bind:false`, contradicting cross-project read semantics.

### Design

- Every stdio MCP subprocess test gets a unique temporary working directory and removes it during teardown.
- Tests that exercise session binding pass an explicit stable `sessionId`; they do not depend on a repository marker.
- `tim_load_project` synchronizes `.tim-project` only when `bind:true`. `bind:false` and deprecated `tim_read_project` are read-only with respect to session and marker state.
- `tim resolve-project --format directive` validates the marker label against the configured store before emitting a binding instruction.
- A pattern-valid but missing project produces an actionable stale-marker directive. It never instructs the agent to load the missing project and never silently falls through to `tim.json`.
- The valid canonical `tim.json` default remains unchanged. Repair remains explicit through `tim bind-project`.

### Acceptance

- Loading P8001 from a temporary test database cannot create or modify any marker outside that test directory.
- `bind:false` leaves marker bytes and mtime unchanged.
- A stale marker cannot generate `ACTION: call tim_load_project(label="<missing>")`.
- The previously failing load-gate test passes without a repository marker.

## 2. Issue #3: reserved Inbox repair

`ensureInboxProject` treats P0000 as a reserved system identity. If P0000 is absent, it creates it. If any P0000 row already exists, it repairs that row in one transaction instead of inserting a duplicate.

Repair preserves user content and non-conflicting metadata while enforcing `kind=project`, `label=P0000`, `is_system=true`, the canonical render depth, active/non-tombstoned state, and required system tags. The update is staged for sync exactly once. Repeated and concurrent calls converge on one valid row.

Acceptance covers missing/faulty `kind`, missing prefix, wrong tags, tombstones, idempotency, concurrent calls, rollback, and successful session start afterward.

## 3. Issue #5: bounded search responses

`tim_search` returns a search-specific representation rather than unconstrained full entries. Each result retains identity, title, relevance/order information, tags, and the metadata fields required by current administrative consumers. Body content becomes a bounded Unicode-safe excerpt; full content remains available through `tim_read`.

The response enforces both a per-result excerpt limit and a hard UTF-8 byte budget for the entire serialized payload. It reports `returned`, `omitted`, and `truncated`. Defaults remain useful for interactive search while preventing a large database or `topK=100` from flooding model context. The migration script is updated to consume the bounded representation without losing required metadata.

Acceptance uses 20–100 kB entries, multibyte text, high `topK`, stable ordering, filter compatibility, migration compatibility, and a deterministic maximum response size.

## 4. Issue #4: executable MCP configuration

All host installers use one server-command resolver. The generated configuration invokes `process.execPath` with an absolute, verified path to `tim-mcp/dist/server.js`; it never writes the unpublished `npx tim-mcp` command.

Resolution supports the packaged sibling dependency and the monorepo layout, plus an explicit `TIM_MCP_SERVER` override for development. Missing server artifacts fail before any host configuration is changed. Existing unrelated host configuration is preserved.

Acceptance creates each supported host configuration in a temporary home, verifies paths with spaces, and performs an MCP initialize plus `tim_stats` against the referenced command.

## 5. Issue #6: CLI, paths, and skill naming

- A central help gate handles `-h` and `--help` before command execution, so help cannot touch the database or markers.
- Argument parsing distinguishes boolean and value options, supports `--name=value` and `--`, and preserves values beginning with `--` after the terminator.
- Hook scripts resolve the installed CLI through an override, `command -v tim`, or a relocatable package-relative fallback. No author-home paths remain.
- Generated documentation and comments use portable installation paths.
- Session directives name the shipped `tim-session-start` skill. Backward compatibility may be provided by an alias, but generated instructions use only the canonical name.

Acceptance is a help matrix for all commands, parser edge cases, relocated checkout execution, source-tree and installed-package execution, and a scan preventing author-home paths or nonexistent skill names.

## 6. Issues #7 and #8: Claude prompt and exchange producers

One stdin-driven CLI hook surface owns Claude integration:

- `tim hook prompt-submit` parses a Claude `UserPromptSubmit` payload, calls the existing prompt-submit library, and emits the exact Claude hook envelope only when context is available.
- `tim hook claude-stop` parses the Stop payload and bounded transcript JSONL, selects the last genuine user/assistant exchange, and logs it through the existing session pipeline.
- Missing sessions are started idempotently once, then logging is retried.
- Duplicate Stop deliveries use a deterministic exchange key derived from session identity and transcript turn identity, preventing double counters and checkpoints.
- Empty, malformed, timed-out, disabled, or unsupported payloads fail soft with exit code 0 and no injected context.
- `setup-agent --host claude` merges both hooks into the user's settings without overwriting unrelated hooks or settings.
- Agent instructions no longer ask models to call internal `tim_session_log` themselves. The tool may remain internal.
- Marker discovery for logging is explicitly scoped to the supplied working directory and cannot select a home marker by default.

Prompt text and transcript bodies are bounded before parsing/logging. Shell commands receive data through stdin or environment variables, never interpolation. Initial delivery targets Claude because it has a defined hook protocol and installer; other harness-specific producers remain outside this issue set.

Acceptance includes malformed JSON, JSONL variants, meta messages, Unicode, size limits, shell characters, missing markers/sessions, duplicate Stop events, settings merge behavior, and an end-to-end five-exchange checkpoint cycle.

## Integration order

1. Marker safety and P8001.
2. Inbox repair and bounded search, in either order after their independent reviews.
3. MCP command resolver.
4. CLI/path/skill cleanup.
5. Prompt-submit and Stop-hook delivery.
6. Workspace build, lint, full test suite, and targeted smoke tests from generated host configurations.

The marker fix lands first so later test runs cannot contaminate repository state. Shared CLI/hook changes remain serial to avoid conflict-driven accidental behavior changes.

## Non-goals

- Publishing TIM packages to npm in this change set.
- Adding Stop-hook producers for harnesses without a specified payload contract.
- Automatically deleting or silently replacing stale user markers.
- Refactoring unrelated storage, search ranking, or CLI command architecture.
- Closing GitHub issues or publishing releases without separate authorization.

## Completion criteria

- All issue-specific regression tests pass.
- `npm run build`, `npm run lint`, and `npm test` pass from the integration worktree.
- Marker content outside test directories is unchanged by the test suite.
- Generated MCP configurations start a real server successfully.
- No open specification or quality-review findings remain.
