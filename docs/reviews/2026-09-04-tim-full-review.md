# TIM — Full review, 2026-09-04

Host: strato (`ubun`). Branch under review: `fix/review-4dd2bf7-deploy` (HEAD `0b127cf`),
three commits ahead of `master`. Reviewer: Claude Opus 5.

Scope, in the order it was worked:

1. The three unreviewed disk-safety commits on the branch.
2. Deployment and build integrity (how the running install relates to the repo).
3. Package-level pass across the ten workspaces, entry points and failure paths.
4. Operational health (`tim_doctor`, `tim_error_stats`, cron wiring, test suite).

Everything below was verified against the working tree on this machine. Where a finding
rests on a race or a path not exercised here, the report says so.

---

## 1. Baseline: what is green

| Check | Result |
|---|---|
| `npx vitest run` | **209 test files, 1799 passed, 2 skipped, 0 failed** (54 s) |
| `tim_doctor` | Status **WARN** — 12345 entries, 1631 edges, FTS5 OK |
| `tim_health` | No blockers; 3 broken links, 73 orphans, 84 stale entries |
| `tim_error_stats` (24 h) | 44 errors, 1.83/h — no runaway |
| MCP connectivity | `tim_preview_briefing`, `tim_doctor`, `tim_health`, `tim_error_stats` all answered |

The test run used `npx vitest run`, which deliberately skips the `pretest: npm run build`
hook so that a rebuild could not disturb the live MCP server. Cross-package imports
(`tim-store` → `tim-core`) resolve through `package.json` `main` to `dist/`, so the run
exercised the current `dist/`. That `dist/` was rebuilt at the end of the previous session,
so the evidence is sound — but see Finding 1 for why this is fragile rather than a
one-off.

The 44 errors are dominated by one repeated message: 35 × `session exhausted 3 idle-sweep
attempts without a new summary — skipped`, all from the `idle_sweep` tool. That is the
existing "Summarizer Quality Follow-Up" and "Reap session skeletons" work, not a new
regression. The remaining 9 are `opencode/deepseek-v4-flash-free` worker spawn failures
from 2026-09-03, unrelated to TIM itself.

---

## 2. Findings

Ranked by consequence.

### Finding 1 — `dist/` is half-tracked in git, and the running install *is* the git working tree (critical)

This is the root cause of the 2026-09-03 outage, and last session's `npm run build` fixed
the symptom, not the cause.

- `.gitignore:1` contains `dist/`.
- Nevertheless **564 files under `packages/*/dist/` are tracked** (`git ls-files | grep -c '/dist/'`).
  `.gitignore` does not untrack files that were already added, so the repository carries a
  frozen, partial build.
- Because the ignore rule *is* active for new paths, files added later never enter the
  index. `packages/tim-core/dist/maintenance-lock.{js,d.ts,js.map,d.ts.map}` and
  `packages/tim-core/dist/summary-budget.*` exist on disk but are **absent from
  `git ls-files packages/tim-core/dist/`** — while `dist/index.js`, which `require`s them,
  *is* tracked and was updated by commit `0b127cf`.

The result is a tracked build artefact that is internally inconsistent: `index.js` imports
modules that git does not carry.

What makes this critical rather than merely untidy is where the code runs:

```
/home/bbbee/.local/bin/tim  ->  /home/bbbee/projects/tim/packages/tim-cli/dist/cli.js
~/.claude.json MCP server   ->  /home/bbbee/projects/tim/packages/tim-mcp/dist/server.js
```

Production is the git working tree. Any `git checkout`, `git stash`, branch switch, or
`git clean -xdf` rewrites the running binary in place. A checkout that restores the tracked
`dist/index.js` without the untracked `maintenance-lock.js` reproduces exactly
`Error: Cannot find module './maintenance-lock.js'` → `CONNECTION_CLOSED`. This will recur
on the next new module in any package, without warning.

**Recommendation.** Untrack the build output and let it be built, not committed:

```bash
git rm -r --cached packages/*/dist && git commit -m "chore: untrack build output"
```

The root `package.json` already has `"prepare": "npm run clean && npm run build"`, so a
fresh `npm install` produces `dist/` — nothing depends on it being in the index.

One operational caveat when doing this **on this box**: `clean` is
`rm -rf packages/*/dist`, and `prepare` runs on every `npm install`. Because production is
this working tree, that command deletes the running MCP server and the `tim` CLI mid-install.
Stop the MCP server first, or rebuild incrementally with `npx tsc -b` instead of going
through `prepare`. (This review's test run avoided `npm test` for the same reason — its
`pretest` hook chains to `build`.) If some
deploy path genuinely needs a committed build, the opposite fix (force-add the whole of
`dist/` and remove the ignore rule) is coherent too; the current half-and-half state is the
only option that cannot work.

### Finding 2 — `check-build-output.mjs` could not have caught the outage, and does not run in CI (high)

Two independent gaps behind the same guard.

`scripts/check-build-output.mjs` verifies seven hard-coded entry points exist and that four
of them are executable. `maintenance-lock.js` and `summary-budget.js` are not entry points,
so a build missing them passes the check unchanged. The guard tests permissions, not
completeness.

Separately, `.github/workflows/ci.yml` runs `npm ci`, `npm run build`, `npm run lint`,
`npm test`. It never runs `npm run test:build-pipeline`, the only script that invokes
`check-clean-output.mjs` and `check-build-output.mjs`. The guard exists and is unreachable
in automation.

**Recommendation.** Add `test:build-pipeline` to CI, and make the completeness check derive
from the sources rather than a literal list — for each package, assert that every
`src/*.ts` that is not a test has a corresponding `dist/*.js`. That check would have failed
loudly on 2026-09-03.

### Finding 3 — automatic `error_log` rotation was removed, and nothing replaced it (high)

`packages/tim-store/src/error-log.ts` previously called `this.rotate()` on every
`logError()`. Commit `85c793d` removes that call, with the comment:

```
// Heavy cleanup is explicit (tim compact-error-log). Routine logging must
// not rebuild, DROP, VACUUM, or mass-DELETE on the write path.
```

The reasoning is right — a mass `DELETE` on the write path is what produced the 69 GB WAL.
But the replacement is a manual command, and **`tim compact-error-log` is not scheduled**.
`crontab -l` lists six TIM jobs (WAL watchdog, DB header watchdog, single-instance check,
snapshot, snapshot watchdog, snapshot prune) and none of them touch `error_log`.
`scripts/tim-compact-error-log.sh` was written on this branch and never wired up.

Verified that no other caller took over the job:

```
$ grep -rn '\.rotate(' --include=*.ts packages/*/src | grep -v __tests__
packages/tim-store/src/error-log.ts:46:  logger.rotate({ maxEntries, maxAgeDays: 365 });
```

The single remaining call site is inside `compactErrorLog()`, which only the CLI command
invokes. No health check, idle sweep, or server path calls `rotate()`.

Net effect: `error_log` is once again unbounded. Growth is slower than the EPIPE storm
because the EPIPE guard (`6a38034`, extended by `handleStdioStreamError` on this branch)
stops the storm at source, but the backstop that used to cap the table is gone.

**Recommendation.** Add a daily cron entry alongside the existing jobs, e.g.

```
41 4 * * * /home/bbbee/.hermes/scripts/tim-compact-error-log.sh >> /home/bbbee/.hermes/cron-outputs/tim-compact-error-log.log 2>&1
```

and deploy `scripts/tim-compact-error-log.sh` to `~/.hermes/scripts/` (see Finding 4).

### Finding 4 — production runs a WAL watchdog that exists in no commit, and it reaps on the metric the branch was written to abandon (high)

Cron executes `/home/bbbee/.hermes/scripts/*.sh`, which are **copies** of the repo scripts,
not symlinks. Comparing the five:

| Script | Deployed vs `scripts/cron/` (branch) |
|---|---|
| `tim-snapshot.sh` | identical |
| `tim-snapshot-watchdog.sh` | identical |
| `tim-snapshot-prune.sh` | identical |
| `tim-single-instance-check.sh` | identical |
| `tim-wal-watchdog.sh` | **diverged, 84 differing lines** |

Four of five matching confirms the convention: the repo file is copied by hand into
`~/.hermes/scripts/`. The one that differs is the one this branch rewrote.

The direction of the divergence matters, so it was checked in both directions. The deployed
file (`Sep 3 13:48`, i.e. written during the incident) is **not** the `master` version and
**not** the branch version — it sits between them:

- Against `master` it is *ahead*: it already has `reap_stdio_writers()`, `run_checkpoint()`,
  and checkpoint-timeout-as-failure. That is the content of commit `090d0a0`.
- Against the branch it is *behind*: it lacks everything commit `0b127cf` added —
  `MIN_WRITE_RATE_BPS` / `SAMPLE_SEC`, the two-sample `sample_stdio_writers()` rate
  measurement, the 20 % ambiguity guard, and the busy-flag parse inside
  `checkpoint_failed()`.

So production carries a hand-deployed intermediate that matches no commit's working tree.
The concrete consequence is not cosmetic: the deployed `reap_stdio_writers()` picks its
victim by **lifetime `write_bytes` from `/proc/<pid>/io`**:

```bash
elif [[ "${writes}" -gt "${best_writes}" ]]; then
  best_writes="${writes}"; best_pid="${pid}"
```

That is precisely the behaviour `0b127cf` was written to remove — its own header says
"rate over interval, not lifetime bytes". Under the deployed logic, the process most likely
to be killed on a WAL alarm is the *oldest healthy* MCP server, because it has accumulated
the most bytes over its lifetime, not the one currently running away. It also has no
ambiguity guard, so it always kills someone.

**Recommendation.** Before overwriting, keep a copy of the deployed file — it is the only
record of what actually ran during the 2026-09-03 incident. Then deploy the branch version
and remove the manual step: make `~/.hermes/scripts/tim-*.sh` symlinks into `scripts/cron/`,
or add a `scripts/deploy-cron.sh` that syncs them, and put it in the merge checklist.

### Finding 5 — `restore` restarts the MCP server while it still holds the maintenance lock (medium-high)

`packages/tim-cli/src/restore.ts` acquires the lock at the top of a `try` block and releases
it in the matching `finally`. Step 6, "Start MCP server", runs *inside* the `try`:

```ts
maintenance = acquireMaintenanceLock({ dbPath, operation: 'restore' });
...
// 6. Start MCP server
if (startScript) { runScript(startScript); }
...
} finally {
  maintenance?.release();
}
```

The freshly started server calls `getStore()` → `assertMaintenanceClear(DB_PATH)`
(`packages/tim-mcp/src/server.ts:1645`), finds the lock file, finds the restore process
still alive, and exits:

```
FATAL: database maintenance in progress (restore); refusing to open writer
```

— which surfaces to the host as `CONNECTION_CLOSED`, the same symptom Benni reported.

Step 6 is reachable on this machine: it is guarded by `if (startScript)`, and
`whichScript(START_SCRIPT_CANDIDATES)` resolves — both
`~/.hermes/scripts/tim-mcp-start.sh` and `~/bin/tim-mcp-start.sh` exist here.

Scope of the risk, stated honestly: `getStore()` is lazy, so the server only dies if a tool
call arrives in the window between `runScript(startScript)` returning and the restore
process exiting. That window is milliseconds on the success path, so this has probably never
fired. It is still an ordering defect — a writer must never be restarted while a maintenance
lock is held — and the window widens with any start script that blocks.

**Recommendation.** Release the lock before step 6:

```ts
maintenance.release();
maintenance = null;
// then start the MCP server
```

The `finally` remains as the failure-path release.

### Finding 6 — `rebuildKeepNewest` can destroy `error_log` outright (medium-high)

`packages/tim-store/src/error-log.ts`:

```ts
this.db.exec(`
  DROP TABLE error_log;
  ALTER TABLE error_log_keep RENAME TO error_log;
  ...
`);
```

`db.exec` with multiple statements runs them in autocommit — there is no enclosing
transaction. A crash, `SIGKILL`, or the very disk-full condition this code exists to handle,
landing between `DROP` and `RENAME`, leaves the database with no `error_log` table at all.

Two secondary problems in the same method:

- `CREATE TABLE error_log_keep` has no `IF NOT EXISTS` and no preceding `DROP`. After a
  crashed rebuild, every subsequent `rotate()` throws on the leftover table. On the
  `logError()` path that throw is swallowed, but `compactErrorLog()` surfaces it, so the
  CLI command becomes permanently broken until someone drops the table by hand.
- The rebuild keeps only the newest N rows by timestamp. `logSchemaMigration()`
  (`packages/tim-store/src/schema.ts:399`) writes migration records into this same table
  with `tool='schema_migration'`. Compaction silently discards migration history. This is an
  audit-trail loss, not a correctness bug — the applied schema version lives in the
  `user_version` pragma, so migrations do not re-run — but the records were put there
  deliberately and should survive.

**Recommendation.** Wrap the rebuild in `db.transaction(...)`; add `DROP TABLE IF EXISTS
error_log_keep` before the create; and exclude `tool = 'schema_migration'` rows from the
pruning predicate so the audit trail is preserved.

### Finding 7 — `compact-error-log` leaves a full-size DB copy behind on every run (medium)

`packages/tim-cli/src/compact-error-log.ts:85,98`:

```ts
const backupPath = `${dbPath}.pre-compact-${Date.now()}`;
...
fs.copyFileSync(dbPath, backupPath);
```

The backup is never deleted — not on success (line 116 prints the path and returns) and not
on any failure path. Every invocation of a disk-safety command therefore permanently
consumes another copy of the database. Once Finding 3's cron entry exists, that is a copy
per day.

Compounding it: there is a free-space preflight for `VACUUM`
(`vacuumHasRoom`, 1.1× headroom) but **none for the mandatory backup copy**, which is the
first thing the command does. Invoked in the situation it was built for — a disk near full —
`copyFileSync` either fails or finishes the job of filling the disk.

**Recommendation.** Check free space before `copyFileSync` using the existing
`readFreeBytes()`, and delete the backup on success. If backups should be retained, give
them the same age/count pruning the snapshot directory already has.

### Finding 8 — the update check reports a downgrade as an available update (medium)

`packages/tim-hooks/src/update-check.ts:54`:

```ts
if (latest === installed) return null;
return `TIM ${latest} available (installed: ${installed}) — npm i -g ${PACKAGE_NAME}`;
```

The comparison is equality, not ordering. Any difference produces an "available" line,
including when the installed build is newer than the registry's. This is live right now: the
session briefing prints

```
TIM 0.1.0-beta.0 available (installed: 0.1.0-beta.1) — npm i -g tim-mcp
```

which advises downgrading. Since the running install is a local build off `master` + branch
work, it will be ahead of npm most of the time, and the banner is permanent noise.

**Recommendation.** Compare with a semver-ordering check and return `null` unless `latest`
is strictly greater. A three-field numeric-plus-prerelease compare is enough; no dependency
is needed for a version string this project controls.

### Finding 9 — writer discovery fails open on a plausible invocation (medium)

Two places identify the MCP server by matching its command line:

- `packages/tim-cli/src/writers.ts:13` — `'tim-mcp.*dist/server\\.js'`, via `pgrep -f`
- `packages/tim-cli/src/wal-watchdog.ts:5` — `cmd.includes('tim-mcp') && cmd.includes('dist/server.js')`

Both require the literal `tim-mcp` to appear *before* `dist/server.js` in the command line.
The configured invocation in `~/.claude.json` uses the full path and matches. A server
started as `node dist/server.js` from within `packages/tim-mcp/`, or through a `bin` shim
that resolves to a different string, does not.

The consequence is asymmetric and bad: `requireNoWriters()` is the fail-closed guard for
`restore` and `compact-error-log`. A writer it cannot see is a writer those commands proceed
against. The module's own header comment reads "Fail-closed TIM MCP writer discovery for
destructive maintenance" — an unmatched writer is precisely the fail-open case it means to
exclude.

The error handling around it *is* correct and worth keeping: `pgrep` exit 1 is treated as
"no matches", every other failure is fatal (`writers.ts:26-33`). Only the pattern is too
narrow.

**Recommendation.** Match on `dist/server\.js` and confirm the process identity by reading
`/proc/<pid>/cwd` or the resolved script path, rather than relying on the package name
appearing in `argv`.

### Finding 10 — `isProcessAlive` treats a permission error as "dead" (low)

`packages/tim-core/src/maintenance-lock.ts:21-29`:

```ts
try { process.kill(pid, 0); return true; } catch { return false; }
```

`process.kill(pid, 0)` throws `EPERM` when the process exists but belongs to another user,
and `ESRCH` when it does not exist. The bare `catch` collapses both to "dead", so
`isMaintenanceActive()` deletes a live holder's lock file and lets a second maintenance
operation start against a database another user's process is rewriting.

On this single-user host the path is unreachable today. It is still a fail-open branch in a
module whose entire purpose is failing closed, and it costs one line to fix.

**Recommendation.** `catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }`

### Finding 11 — `stderr` error handler writes to `stderr` (low)

`packages/tim-mcp/src/process-error-guards.ts`, `handleStdioStreamError`, is registered on
both `process.stdout` and `process.stderr` (`server.ts:3705-3706`). For a broken pipe it
exits, which is correct. For anything else it calls `console.error(...)` — a write to
`stderr`. If the failing stream *is* `stderr` and the fault is persistent (the `ENOSPC` case
the test at `process-error-guards.test.ts:63` constructs), the handler's own write can raise
another `error` event and recurse.

**Recommendation.** Pass the stream identity into the handler and drop the log when the
failing stream is the one being logged to, or guard with a re-entry flag.

### Finding 12 — `process.exit()` inside `try/finally` skips lock release (informational)

`restore.ts`, `compact-error-log.ts` and `server.ts` all call `process.exit(1)` from inside
blocks whose `finally` releases the maintenance lock. `process.exit()` does not run `finally`
blocks, so each of those paths leaves the lock file on disk.

This is *not* a defect, because `isMaintenanceActive()` checks holder liveness and unlinks
the file when the PID is gone — the design self-heals. It is recorded here so the next
reader does not "fix" the exits and does not mistake a leftover
`/tmp/tim-maintenance-*.lock` for a stuck operation. It is worth a comment in the code
saying so.

---

## 3. Package-level notes

Nothing below rises to a finding; these are observations from the pass over each workspace.

| Package | Lines | Notes |
|---|---|---|
| `tim-store` | 18 253 | Largest surface, data integrity. Findings 6 and 3 live here. `compactErrorLog` hard-codes `maxAgeDays: 365`, ignoring configured retention — harmless today, surprising later. |
| `tim-mcp` | 16 928 | The MCP guard at `server.ts:1645` is skipped for HTTP mode (`!CLI.http`) and can be disabled with `HERMES_SKIP_DB_GUARD`. Both are deliberate escape hatches; the HTTP exemption means an HTTP-mode server will happily write during a restore. Worth either closing or documenting as a known limitation. |
| `tim-cli` | 13 967 | Findings 5, 7, 9. The snapshot capacity work (`snapshotFootprintBytes` counting db + WAL, `makeRoomForSnapshot` pruning by cap before deleting the last valid copy) is careful and well-tested; the comment recording the 2026-09-03 incident that motivated it is exactly the right kind of comment. |
| `tim-hooks` | 7 460 | Finding 8. |
| `tim-migrate` | 3 136 | Not opened in this pass — untouched by the branch and unrelated to the incidents under review. Treat as unreviewed, not as clean. |
| `tim-summarizer` | 2 448 | The 35 idle-sweep errors point here; already tracked as "Summarizer Quality Follow-Up". |
| `tim-core` | 2 129 | Findings 10, 12. `acquireMaintenanceLock` correctly uses `openSync(path, 'wx')` for atomic creation rather than a check-then-create race — good. |
| `tim-sync-client` | 1 890 | Not opened; sync is off pending the open "mirror the database to the sync server" task. |
| `tim-sync-server` | 1 062 | Two open P1 tasks already recorded (blob compaction, reverse-proxy hardening). Not re-reviewed. |
| `tim-skills` | 838 | Not opened in this pass — same reason. Treat as unreviewed. |

One structural note on the branch itself: of 2 511 added lines, roughly 1 000 are committed
`dist/` output and source maps. That is review noise created by Finding 1, and resolving
Finding 1 removes it.

---

## 4. Health warnings (reported, not fixed)

`tim_doctor` reports **WARN** with no blockers:

- 3 broken links
- 73 orphan entries
- 84 stale entries (older than 90 d, unverified)

Cleaning these was outside the scope of this review. They are curation debt, not
correctness problems, and `tim-project-curate` exists for exactly this.

---

## 5. Suggested order of work

1. **Finding 1** — untrack `dist/`. Everything else is easier afterwards, and it closes the
   failure mode that took TIM down on 2026-09-03.
2. **Finding 4** — archive the deployed watchdog, then deploy the branch version and make the
   cron scripts symlinks, so "merged" and "running" stop being different things. Until then
   the hourly job reaps by lifetime bytes and will pick the wrong process.
3. **Finding 3** — schedule `compact-error-log`, restoring the backstop the branch removed.
4. **Finding 2** — wire `test:build-pipeline` into CI and make the build check derive its
   file list from `src/`.
5. **Findings 6, 5, 7** — the transaction, the lock-release ordering, the backup cleanup and
   its preflight. All small, all in code that is already on the branch.
6. **Findings 8, 9, 10, 11** — the fail-open and noise fixes.

Findings 1–4 are deployment and process; 5–12 are code. The branch's actual logic is in good
shape — the checkpoint busy-flag verification, the rate-based reaping, the snapshot capacity
handling and the removal of `rotate()` from the write path are all correct responses to the
incidents that prompted them. What is missing is the last mile: getting them into the
processes that actually run, and closing the gaps the fail-closed design left open.
