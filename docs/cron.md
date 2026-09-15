# TIM cron jobs

Cron runs **copies** in `~/.hermes/scripts/`, not the repo files and not
symlinks. A merged change is not a running change until `scripts/deploy-cron.sh`
has copied it over. On 2026-09-03 the deployed `tim-wal-watchdog.sh` matched no
commit at all — see review Finding 4.

Deploy with:

```bash
bash scripts/deploy-cron.sh --dry-run   # show what would change
bash scripts/deploy-cron.sh             # archive, then copy
```

The existing entries are overwritten, never appended to; the old file is
archived to `~/.hermes/scripts/archive/<name>.<timestamp>` first.

## Crontab

The repo does not install crontab lines — a human pastes them into `crontab -e`.
`scripts/deploy-cron.sh` prints the block below when a script it deployed has no
matching entry, so the two cannot drift silently.

```cron
*/30 * * * * /home/bbbee/.hermes/scripts/tim-snapshot.sh >> /home/bbbee/.hermes/cron-outputs/tim-snapshot.log 2>&1
0 * * * * /home/bbbee/.hermes/scripts/tim-wal-watchdog.sh >> /home/bbbee/.hermes/cron-outputs/tim-wal-watchdog.log 2>&1
41 4 * * * /home/bbbee/.hermes/scripts/tim-compact-error-log.sh >> /home/bbbee/.hermes/cron-outputs/tim-compact-error-log.log 2>&1
```

Only the third line is new (review Finding 3). The other jobs
(`tim-snapshot-watchdog.sh`, `tim-snapshot-prune.sh`,
`tim-single-instance-check.sh`, the DB header watchdog) are already registered;
`crontab -l` is authoritative for their exact schedules.

### Why `tim-compact-error-log.sh` needs an entry

`ErrorLogger.logError()` used to call `this.rotate()` on every write. Commit
`85c793d` removed that — correctly, a mass `DELETE` on the write path is what
produced the 69 GB WAL — and replaced it with the explicit
`tim compact-error-log`. Nothing scheduled that replacement, so `error_log` is
unbounded again. The daily 04:41 entry is the backstop. It only runs when no TIM MCP process is
alive; otherwise it logs `SKIP` with the process IDs and retries at the next
scheduled run. A process-discovery error fails closed. The CLI repeats writer
verification under its maintenance lock before touching the database.

Unattended compaction never stops or starts MCP servers. The old stop/start
wrapper killed host-owned stdio children every night. Starting an HTTP daemon
cannot restore those existing Claude Code, Cursor, or Codex pipes.

On a machine with continuously running MCP servers, compaction will remain
deferred. Arrange an explicit maintenance window, close the host sessions (and
stop any HTTP daemon), then run `tim compact-error-log --vacuum`. Start the
hosts again afterward. `scripts/tim-mcp-stop.sh` remains an explicit, disruptive
operator tool for maintenance such as restores; cron does not call it.

### Environment cron does not give you

Cron's `PATH` is minimal and its cwd is `$HOME`. The scripts therefore resolve
things explicitly:

| Variable | Default | Why |
|---|---|---|
| `TIM_ROOT` | `~/projects/tim` | The deployed copy lives in `~/.hermes/scripts/`, so `dirname $0/..` is not the checkout. |
| `TIM_NODE` | `command -v node` | Fails loudly with a clear message if `node` is not on cron's `PATH`. |
| `TIM_COMPACT_VACUUM` | `1` | Set to `0` to skip the VACUUM. It is the expensive step and needs 1.1× the DB size free. |
| `TIM_COMPACT_TIMEOUT_SEC` | `900` | An unbounded VACUUM on a multi-GB DB would hold the MCP server down indefinitely. |
| `TIM_COMPACT_KEEP_BACKUPS` | `2` | Each run copies the whole DB to `*.pre-compact-*`. Daily and unpruned, that fills the disk. |

Every script takes a `flock` and exits 0 when a previous run is still going, so
a slow run cannot stack.

## Building on this host

See the "Building on the production host" section of the README before running
any `npm` command here: the working tree *is* the install.
