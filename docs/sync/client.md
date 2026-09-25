# TIM sync client contract (T03)

This is the client durability contract. The wire contract stays in `protocol.md`. T04+ (secret payload versioning, hosted hardening, deployment, mirror/join) are out of scope except where this file says a later ticket must keep using the same lock.

No schema migration is required. `staging.rowid` is already `INTEGER PRIMARY KEY AUTOINCREMENT` and is the staged revision. SQLite does not reuse those rowids. Staging collapse deletes other unacked rows; it does not copy a queued rowid onto the survivor.

## Locks

Two advisory locks live under `~/.tim/sync-locks/` (directory mode `0700`). A lock file is mode `0600` and records pid, Linux `/proc/<pid>/stat` start time, and a random token. `flock` is not required. A holder is alive only when `kill(pid, 0)` succeeds and the start time still matches. A dead or reused pid is stale: recovery renames the lock aside and deletes it only when the renamed record is still the dead holder. A live holder is never stolen.

The **mutation lock** (`mutation.lock`) is one lock for the sync directory. Push, pull, connect, mirror, repair, disconnect, and every config, state, or queue read-modify-write take it and hold it across the whole operation, including network waits. Atomic rename is crash safety only. It does not stop two processes from both reading the old file and both renaming a replacement. The lock is what stops that. Nested calls in the same async operation re-enter. A different process waits. A same-process caller that is not inside the operation and cannot yield fails with `SYNC_LOCK_BUSY` instead of deadlocking.

The **owner lock** is one file per canonical database path (`owner-<sha256>.lock`). Canonical path is `realpath` of an existing database, or `:memory:`. The periodic owner holds it for its lifetime. A second owner sees a live holder and exits 0 without starting another loop. MCP and other in-process timers skip periodic push/pull while that holder is alive. Explicit `tim sync push` and `tim sync pull` still run; they take the mutation lock and therefore cannot interleave with the owner cycle. There is no systemd unit and this ticket does not start an owner on the machine.

Mirror is not implemented here (T10). T10 mirror must call `withSyncMutationAsync` for the whole mirror. It must not write config, state, or queue beside that lock.

## Private files

Queue files, `sync-state.json`, `sync.json`, `device-id`, and lock files are written to a unique temporary file in the same directory (`<name>.<pid>.<uuid>.tmp`), created with `O_EXCL` and mode `0600`, fsynced, then renamed over the target. The directory is fsynced after rename and chmod'd to `0700`. Replacing an existing file keeps mode `0600` because the new inode is `0600`. A failed write, including `ENOSPC`, deletes only the temporary file and leaves the previous queue or state file unchanged.

An empty queue removes the queue file. That delete happens only after the in-memory queue is empty and the mutation lock is held. It is not a replace-via-truncate.

`sync-state.json` carries `stateEpoch`, a non-negative integer. A save writes `onDisk + 1` and refuses when the caller's epoch differs, unless the caller is an explicit repair/replace. A missing epoch on a legacy file is 0. Cursor and error-field updates use the epoch they loaded inside the mutation lock. A stale process cannot rename an older cursor over a newer one.

## Staged revisions

A queue item stores the staging rowids it captured, aligned with its envelopes, plus the envelopes and blobs from that moment. Those fields are the queued version. Later staging collapse or a same-millisecond insert must not change them. Retry keeps the same `idempotency_key` unless secret blocking changes which envelopes are in the item (existing secret split).

Push reads unacked staging inside the mutation lock and enqueues a rowid only when no queue item already lists it. Ack is `UPDATE staging SET acked = 1 WHERE rowid = ?`. It is not `lww_timestamp <= ?`. A row inserted in the same millisecond, which collapse keeps under a new rowid, stays unacked. Placeholder secret rows that are intentionally not pushed are acked by their own rowids.

Order after the server accepts a batch:

1. Ack those exact rowids.
2. Remove that item from the queue and save.

Crash after the server commit and before ack leaves the item, including its idempotency key and rowids. The next cycle replays the same key and then acks only those rowids. Crash after ack and before queue removal replays an already-acked row and then drops the item. Neither path acks a newer rowid, and neither invents a wall-clock timestamp.

Legacy queue items with no `revisions` array are still sent. They are not acked by timestamp. Their staging rows are enqueued with rowids on a later cycle if they are still unacked. That may deliver the same logical version twice; the server idempotency key on the new item is new, and last-writer-wins keeps the newest payload.

## Byte bounds

The hosted body limit is 10 MiB. A client batch is at most 500 blobs and at most 8 MiB of UTF-8 JSON for the push body, measured with `Buffer.byteLength` on the serialized body (encryption expansion and multibyte characters included, not JavaScript string length). The estimate uses a fixed overhead for protocol fields so a real request stays under the hosted limit.

A single blob whose own body exceeds 8 MiB is stored as its own queue item with `disposition: "oversized"`. It is not sent, its `attempts` counter is not increased, and a later cycle does not build a new item for that rowid. The push result lists `{ revision, key }` for each parked item. Parked oversized items do not by themselves make the cycle incomplete.

## Deadlines, backoff, and exit status

A cycle takes `deadlineAt` (epoch milliseconds). Each push, pull, file listing, and cursor ACK aborts when the deadline is reached. No request starts after the deadline.

`429` reads `Retry-After` (delta-seconds or HTTP date). The cycle waits, but not past the deadline, and retries the same queue item and idempotency key. If the wait would pass the deadline, the cycle stops. `lastPush` / `lastPull` success timestamps do not move. At most 8 retries happen inside one cycle.

`401`, `403`, and `402` are permanent for that cycle. The client does not retry them, does not ack the failed item, and does not move the success timestamp. The queue item stays so a later invocation can retry after the operator fixes auth or quota.

Exit status for `tim sync push`, `tim sync pull`, and `tim sync owner --once`:

| Code | Meaning |
| --- | --- |
| 0 | Sendable work finished. Oversized rows may be parked and are printed. A second live owner also exits 0 without a cycle. |
| 1 | Usage, config, rejected state, or missing secret passphrase. |
| 2 | Incomplete cycle: deadline, rate limit, network, lock not acquired before the deadline, or sendable items still queued. |
| 3 | Permanent auth or quota failure (`401`, `403`, `402`). |

`tim sync owner` without `--once` is the idle drain. It push-then-pull on an interval (default 30s, default cycle deadline 20s) and does not require an MCP call. Deadline and `429` wait for the next interval. Permanent auth or quota ends the process with status 3. The command is the adapter; installing it as a service is later work.

## What this contract does not do

It does not enable staging, edit `~/.tim/tim.db`, deploy the hosted service, or implement baseline mirror. It does not change edge LWW, file generations, or server ACK monotonicity from T02.
