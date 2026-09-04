# TIM - Theoretically Infinite Memory

TIM is a local-first memory system for AI agents. In this repo, the core user-facing surface is the `tim` CLI, the `tim-mcp` server, the SQLite-backed store, and the migration tools for older `.hmem` databases.

This project is **public beta**. The core is usable, but the interfaces and release shape are still moving. Expect breaking changes.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- SQLite-backed storage via the bundled packages

## Quickstart

```bash
npm install
npm run build
npm run lint
```

Run the CLI from the workspace:

```bash
node packages/tim-cli/dist/cli.js init
node packages/tim-cli/dist/cli.js doctor
node packages/tim-cli/dist/cli.js stats
```

The default database path is `~/.tim/tim.db`. Override it with `TIM_DB_PATH` if you want TIM to use another location.

## Common Commands

- `tim init` - create the database, register the default agent, and write MCP configuration
- `tim doctor` - inspect health, counts, broken links, and orphaned entries
- `tim stats` - print database stats as JSON
- `tim import <file.hmem>` - import an older hmem database
- `tim export <file.hmem>` - export the current TIM database
- `tim snapshot` - create a SQLite backup snapshot
- `tim restore` - restore from a snapshot
- `tim record-commit` - record a git commit in the project tree
- `tim statusline` - render a compact status line for shells or TUIs

Run `tim <command> --help` for command-specific usage. Help for `init`, `doctor`, `stats`, and `import` exits before any database work.

## Migrating From hmem

Agents helping hmem users switch to TIM should follow the migration runbook in
[`docs/hmem-to-tim-migration.md`](docs/hmem-to-tim-migration.md). The safe flow
is: `tim doctor`, `tim import <file.hmem> --dry-run --deduplicate`,
`tim snapshot`, then `tim import <file.hmem> --deduplicate`.

## MCP Setup

`tim init` writes `~/.tim/mcp.json` with a `tim-mcp` entry that points your MCP client at the local database. If you prefer to wire it manually, the server binary is `tim-mcp` and it reads `TIM_DB_PATH`.

## Backup and Restore

Use `tim snapshot` to create a backup copy of the SQLite database, then `tim restore` to bring it back. The snapshot/restore flow is intended for local recovery and migration between machines.

## Building on the production host

`packages/*/dist` is build output and is **not tracked**. `npm install` runs
`prepare`, which is `npm run clean && npm run build` — and `clean` is
`rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo`.

That is harmless on a laptop and dangerous on the host where this checkout *is*
the install:

```
~/.local/bin/tim            ->  <checkout>/packages/tim-cli/dist/cli.js
~/.claude.json MCP server   ->  <checkout>/packages/tim-mcp/dist/server.js
```

There, `npm install`, `npm run prepare`, `npm test` (its `pretest` chains to
`build`) and `npm run test:build-pipeline` all delete the running CLI and MCP
server mid-command. The safe sequences are:

- **Stop the MCP server first**, then build: `bash scripts/tim-mcp-stop.sh && npm run build`.
- **Or build incrementally** and never go through `prepare`: `npx tsc -b && node scripts/ensure-executable-dist.mjs`.

Verify a build with `node scripts/check-build-output.mjs`, which fails naming
any `src/**/*.ts` that has no compiled counterpart. A partial `dist/` is exactly
what took the host down on 2026-09-03: `dist/index.js` was present and required
`./maintenance-lock.js`, which was not.

To run the test suite without rebuilding, use `npx vitest run` — it skips the
`pretest` hook.

Cron scripts have the same merged-is-not-running problem; see
[docs/cron.md](docs/cron.md).

## Sync

TIM-sync exists in this workspace, but it is optional and outside the core local-memory path documented here. Do not expect it to be required for basic CLI, MCP, or migration workflows.
