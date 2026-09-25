# TIM sync production-readiness implementation plan

Date: 2026-09-25. Decision: implement sync soon; it is not parked. Scope: the single-owner Strato deployment, with multiple local agents and a later laptop. This document is a plan, not deployment authorization or an implementation.

## Recommendation and release gates

Deploy a **tailnet-only HTTPS service**, with Tailscale Serve on port 8443, a dedicated loopback nginx upstream, and a loopback-only hosted TIM sync server. Use one tenant, one shared remote file, one sync owner per local database, and independent device identities for independent database replicas. Keep `sync.staging=false` until a complete baseline has been uploaded and verified under a writer freeze. Enable staging before releasing that freeze.

Do not deploy the development sync server. Do not equate an HTTP health response, a non-null timestamp, or zero staging rows with a verified mirror. Do not implement compaction as “keep MAX(id)”; server arrival order differs from TIM's logical conflict order.

The production gates are: safe protocol and edge deletion semantics; bounded, durable client delivery; secret-layer correctness; private deployment; tested backup/restore; observable failures; cursor-safe compaction; and a verified baseline-to-staging handover. The tickets below cover these gates without requiring public SaaS onboarding, billing, Kubernetes, or multi-region replication.

## 1. Current-state audit

### Audit provenance and limits

Repository inspected: `/home/bbbee/projects/tim`, commit `4406ff073e651d07ed73e3daa124e9a0b74a00b6`; the working tree was clean at entry. All repository paths and line references below refer to that commit. No builds or test suites were run in the shared checkout, because its built artifacts serve live processes.

The installed `tim` resolves to `packages/tim-cli/dist/cli.js`. `tim --help` and `docs/tim-cli-reference.md:805` show no generic CLI `read` or `search`. The five task bodies were therefore recovered with `tim export --format text` against a **task-local copy of an existing completed snapshot**, `/home/bbbee/.tim/snapshots/tim-20260925-1900.db` (17:00 UTC). No SQL was issued against the live TIM database or its snapshot. Extracts are in `TASK-EVIDENCE.txt`; snapshot diagnostics are in `SNAPSHOT-DOCTOR.txt`.

**Audit side-effect disclosure:** Initial discovery made three nominally read-only MCP `tim_search` calls before switching to the snapshot. Current MCP search records retrieval usage (`packages/tim-mcp/src/server.ts:2598`; `packages/tim-store/src/store.ts:3960`), so these calls may have written `entry_usage` telemetry and performed its opportunistic cleanup. The first two returned 10 and 1 results; the third returned none. I did not verify whether those best-effort writes succeeded and did not attempt to undo them. No content updates, code/config/service edits, raw SQL, connect, push, pull, staging changes, or migrations were performed. This prevents claiming a strictly zero-write live audit.

The snapshot reports 15,252 visible entries and 2,124 edges, FTS healthy, zero broken links, **70 orphan entries**, and zero unacknowledged staging rows. It also reports existing summarizer warnings. These are snapshot observations, not a fresh live cutover baseline. Exact mirror totals must include hidden/irrelevant/tombstoned records, so visible-entry counts are insufficient.

### Existing task requirements

Task IDs were recovered from the snapshot's recorded task inventory; priorities below are those supplied in the assignment. The bodies were read, not merely their titles.

| Priority | Existing task / recorded ID | Treatment |
|---|---|---|
| P1 | Compaction — `ubun-0707-ns-01KWY63XD6Z0ZACRB03TFTS6MP` | T02 establishes safe ordering/cursors; T08 implements collection. The old age-only suggestion is insufficient by itself. |
| P1 | Reverse proxy / rate limits — `ubun-0707-ns-01KWY6484BJ6BJ16JPYD9FE68D` | T05–T06. Preserve the trust-proxy requirement while keeping ingress private. |
| P1 | Tenant backups / monitoring — `ubun-0707-ns-01KWY64J4NH82EV10EM0MNRMQ9` | T07 and T09, including an actual restore drill. |
| P2 | Mirror then staging — `ubun-0812-ns-01KZTXHHTH9TBJQCDRW0VHS120` | T10–T12. The September 25 decision supersedes the body's old “wait for Benni” planning hold. |
| P2 | Secret-node gaps — `ubun-0707-ns-01KWY64YKH800YS140BJ4PNPM7` | T04 before mirroring real secrets. The old task describes a partially superseded placeholder bug; re-test current behavior. |

### Findings with source evidence

| Area | What exists / what fails | Evidence |
|---|---|---|
| Malformed telemetry | `~/.tim/sync.json` is syntactically valid JSON with **empty serverUrl, userId, token, salt and fileId**. Health rejects the empty file ID and returns null push/pull history **before** inspecting the state file. This is a placeholder configuration, not proof of corrupt JSON or a network diagnosis. | `/home/bbbee/.tim/sync.json:2`; `packages/tim-store/src/memory-health.ts:77` |
| Stale state | `sync-state.json` has `fileId="fake-file-id"`, an empty cursor, and August 12 push/pull timestamps. Once connection config is repaired, this file must be deliberately reset/scoped; its old timestamps must not become evidence for the new server. | `/home/bbbee/.tim/sync-state.json:2`; health mismatch check at `memory-health.ts:117`; context rewrites only fileId at `packages/tim-sync-client/src/sync.ts:536` |
| Staging disabled | `config.json` has `sync.staging=false`. Store construction installs a database-wide trigger suppressing unacked staging inserts. Re-enabling does not backfill historical rows. Store construction also deletes old acked rows, so diagnostic commands opening `TimStore` are not strictly read-only. | `/home/bbbee/.tim/config.json:73`; `packages/tim-store/src/store.ts:384`; `packages/tim-store/src/schema.ts:524` |
| No baseline/join workflow | Push reads only unacked staging. Connect generates a device-derived file ID; a laptop defaults to a separate file instead of joining the existing one. Existing-file connect saves config without resetting state. | `packages/tim-sync-client/src/sync.ts:327`; `packages/tim-cli/src/sync-cli.ts:43`, `:87`, `:98`; `packages/tim-sync-client/src/config.ts:103` |
| Encryption and transport | AES-256-GCM with scrypt exists; envelopes carry entries/edges, LWW metadata and deletes. The server holds ciphertext, but also plaintext object keys, device IDs, timestamps, sizes and file salts. “Blind” does not mean metadata-free. | `packages/tim-sync-client/src/crypto.ts:7`; `envelope.ts:3`; `sync.ts:354`; `packages/tim-sync-server/src/storage.ts:8` |
| Tenant isolation/auth | Random 32-byte bearer tokens resolve a tenant, with separate registry and tenant databases. Registry stores bearer tokens in plaintext; there is no exposed revoke/rotate operation. Admin token protects promotion and detailed health. | `packages/tim-sync-server/src/tenant-registry.ts:17`, `:32`, `:48`; `server.ts:87`, `:146`, `:174` |
| Ingress defects | Hosted startup does not supply a listen host, despite printing localhost. Forwarded client IP is trusted unconditionally. Registration is unauthenticated and has only an in-memory 5/hour/IP limiter. Sync endpoints have no application rate limit. Body size is capped at 10 MiB, but payload/schema validation and request timeouts need hardening. | `packages/tim-sync-server/src/server.ts:6`, `:59`, `:121`, `:206`, `:281`; `cli.ts:7` |
| Append-only server | Every push adds a new blob; pull pages by monotonic ID and already handles lagging client clocks. No compactor, persisted device acknowledgements, cursor generation, server receive time or retention watermark exists. Only `(file_id, updated_at, id)` is indexed, although pull orders by ID. | `packages/tim-sync-server/src/storage.ts:90`, `:121`, `:152`; `tenant-registry.ts:98` |
| Logical winner vs arrival | LWW compares logical timestamp, then original device ID. A delayed stale update can have the highest blob ID. Outer `device_id` is the current sending device while envelope `device` can preserve another origin. A compactor cannot safely infer the latter from ciphertext. | `packages/tim-core/src/lww.ts:15`; `packages/tim-sync-client/src/envelope.ts:50`, `:78`; `sync.ts:358` |
| Quotas/idempotency | Free is 1,000 logical records / 10 MiB; the snapshot already exceeds the entry allowance. Usage groups by proposed ID without file ID, counts latest arrival, and adds full update bytes before checking idempotency. A retry at quota can fail although the original batch was accepted. Duplicate-key success returns empty mappings; request identity is not checked. Neither quotas nor admin health report physical history size. | `packages/tim-sync-server/src/quotas.ts:15`; `storage.ts:45`, `:72`, `:96`; `tenant-registry.ts:126`; existing duplicate behavior test `src/__tests__/storage.test.ts:108` |
| Queue and concurrency | Queue replacement is atomic rename but uses a fixed `.tmp` path and no interprocess lock; state/config writes are not atomic. Guards in auto-sync are process-local, and push/pull have separate flags while sharing a state file. Queue includes envelopes as well as ciphertext and uses default file permissions. | `packages/tim-sync-client/src/queue.ts:7`, `:22`; `config.ts:33`, `:47`, `:84`; `auto-sync.ts:7` |
| Failure reporting/batching | Requests other than basic health have no deadline. Queue chunks by 500 records, not encrypted bytes. Push catches transport failures, still sets `lastPush`, and CLI can exit successfully with “more queued”. Repeated retries can append newly keyed copies of still-unacked rows to an existing queue. Staging acknowledgement by key/timestamp has a documented same-millisecond loss window. | `packages/tim-sync-client/src/client.ts:55`; `queue.ts:15`, `:44`; `sync.ts:354`, `:388`, `:398`, `:410`; `packages/tim-cli/src/sync-cli.ts:140`; `packages/tim-store/src/sync-methods.ts:23` |
| Edge convergence | Remote edge deletion physically removes a row using the remote edge ID, even though lookup uses its composite identity. No durable deletion register remains to reject an older upsert; the local edge tiebreak uses literal `local`. This is a multi-device correctness blocker. Entry tombstones already have dedicated handling. | `packages/tim-store/src/sync-methods.ts:77`, `:271`, `:302`, `:313`, `:321` |
| Secret gaps | Inner encryption covers title/content/metadata but leaves tags in the outer-decrypted payload; no-key placeholders also preserve those tags. Current no-key push already checks effective/inherited secrecy, so an edited placeholder retaining `secret:true` is blocked. Durable `_enc`/locked-state guards, tag encryption and unlock/replay still need explicit tests; title matching alone is not a security boundary. Outer encryption still protects tags from the blind server. | `packages/tim-sync-client/src/sync.ts:80`, `:114`, `:145`, `:192`, `:339`; `src/__tests__/inherited-secret-push.test.ts:65`; store updates do not implement a general locked-placeholder guard |
| Auto-sync is opportunistic | MCP reads schedule pull, writes schedule push. An idle replica has no guaranteed polling interval. CLI/hook/summarizer writes need a periodic owner to drain staging, and a second process must not race the MCP queue. | `packages/tim-mcp/src/server.ts:2116`; `packages/tim-sync-client/src/auto-sync.ts:35`, `:79` |

Existing unit/integration tests cover tenant quotas, body size, token behavior, pagination, skewed clocks, encryption, secret blocking and queue mechanics. They were **inspected, not executed**. New acceptance tests must use the hosted server, not only `startDevServer`.

### Host observations

Read-only checks during this audit found:

- Ubuntu nginx `1.24.0` installed and active; listeners on IPv4/IPv6 ports 80 and 443. `/etc/nginx/sites-enabled/default:2` binds public HTTP. No sync listener on 3100 and no user sync unit were found; the default sync data directory was absent.
- Tailscale is Running at `strato.taila1a529.ts.net`, IPv4 `100.71.123.86`. Existing Serve configuration exposes a different service on 8556, tailnet-only. Ports 8443 and 3101 were not listening. Do not overwrite that configuration or reuse public 443.
- `tim-mcp.service` is active as a user service. Its absolute Node path is `/home/bbbee/.nvm/versions/node/v24.14.0/bin/node`; linger is already enabled. Example: `/home/bbbee/.config/systemd/user/tim-mcp.service:6`.
- `rclone` is installed with a `pcloud:` remote. No remote upload, listing of backup contents or restore was performed. The root filesystem had 76 GiB available, 68% used; this is a capacity observation, not a reserved budget.
- Existing `/home/bbbee/.hermes/scripts/tim-snapshot-prune.sh:76` uploads the newest TIM snapshot daily and retains seven days off-host. It covers the local TIM DB, not tenant/registry databases. Upload failures log but do not make the script fail, and missing rclone returns success (`:78`, `:89`). It is a pattern to improve, not a production backup guarantee.

## 2. Target topology, access and operating contract

```text
Benni's approved tailnet devices / same-host sync owner
    -> https://strato.taila1a529.ts.net:8443
    -> Tailscale Serve HTTPS (tailnet ACL/grant, no Funnel)
    -> nginx at 127.0.0.1:3101 (limits, timeout, request logging)
    -> tim-sync-server at 127.0.0.1:3100
    -> ~/.local/share/tim-sync/{registry.db,tenants/*.db}

~/.tim/tim.db -> one serialized client owner -> encrypted envelopes
consistent server backup bundle -> encrypted rclone remote -> pCloud
```

This fits one owner and an eventual laptop, avoids public registration exposure, and retains the existing nginx operations model. Serve supplies HTTPS while nginx still applies limits. Public 80/443 need no TIM route. This server and the source DB share a disk and machine: sync is a replica mechanism, **not off-host disaster recovery**.

Tailscale Serve is explicitly for tailnet sharing and supports selecting the HTTPS port; verify the installed CLI and preserve existing Serve entries during deployment. HTTPS enablement and restrictive tailnet grants remain deployment prerequisites, not facts proved by local status. See [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

**Access policy:** permit only Benni's approved devices/identity to port 8443. Test a denied tailnet identity and an external network. Keep tenant bearer authentication even within the tailnet. Provision the sole tenant through a local administrative command; make `/register` closed by default and block `/admin/*` at ingress. Use the existing pro tier for this dataset, with explicit physical disk safeguards. `--tier pro` during current registration does not confer pro status: the server creates free tenants.

**Proxy boundary:** default `TRUST_PROXY=false`. If enabled, trust only explicitly configured proxy peers and only a header that the proxy overwrites. Never accept arbitrary `X-Forwarded-For`. For this single-owner topology, use an nginx service-wide limit keyed by its fixed server name plus an application tenant-ID limit; this avoids assuming Serve preserves a trustworthy client IP. Strip incoming forwarded/auth-identity headers that are not required. Forward Authorization without logging it.

**Starting limits, to tune in rehearsal:** 5 requests/second at nginx with burst 20, 8 active connections, 10 MiB hard body limit, 15-second request-body timeout and 30-second upstream timeout. Application limit: 120 requests/minute/tenant, burst 20; disabled registration/admin have a separate local-only limit. Return 429 plus retry guidance, with JSON errors that the client can parse. The client must honor Retry-After and back off with jitter. Start normal push batches at at most 1 MiB encrypted request size and 500 records, whichever comes first; reject oversized single records explicitly. The 1 MiB target is below the server's 10 MiB ceiling, leaving room for overhead. These are engineering defaults, not measured capacity claims. Nginx supports keyed limits, bursts and explicit rejection status: [limit_req documentation](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).

**Keys:** distinguish tenant bearer token, admin credential, outer sync passphrase, secret-node passphrase, and backup encryption key. Never store the latter three on the blind server. Provide owner-client credentials through protected files/systemd credentials, not command arguments or readable unit files. Keep an independently recoverable offline copy of encryption secrets. Local owner processes share a Unix account today; same-UID isolation is not a security guarantee. Token rotation/revocation must be supported before relying on the service.

**Client ownership:** all agents using `~/.tim/tim.db` are one replica. A user timer/service runs serialized pull/push every 60 seconds; MCP hooks may request work but cannot bypass the cross-process lock. A laptop gets a new device ID, the same tenant/file/salt, and its own DB/state/queue. Bootstrap the laptop before allowing local writes. Do not copy device IDs or queue/state files between replicas.

## 3. Ordered implementation tickets

Sizes: S = one narrow change, M = several related changes, L = cross-package/data-lifecycle work that should be split into small reviewable commits. “Mid-tier safe” means suitable for implementation from the stated contract, with ordinary review. “Care required” means senior design/review and adversarial data-loss tests; model capability does not replace that review.

### T01 — Make connection state and diagnostics truthful

- **Goal:** validate config/state schemas; distinguish disconnected placeholder config, invalid JSON, invalid timestamps, mismatched DB/file/server, attempts and successful delivery. Add a genuinely read-only `tim sync audit --json` interface for the later gates. Bind state to canonical local DB identity plus server, tenant, file and protocol generation. Preserve legacy evidence on explicit repair; never silently adopt `fake-file-id`.
- **Files:** `packages/tim-sync-client/src/config.ts`, `sync.ts`; `packages/tim-store/src/memory-health.ts`; `packages/tim-cli/src/sync-cli.ts`, `args.ts`; associated config/health tests and `docs/memory-health.md`.
- **Acceptance:** today's empty config yields a precise disconnected/invalid-config diagnostic; mismatched state cannot supply a cursor. Timeout, 401, 402, 429 and partial send cannot advance last-success timestamps. Audit opens DB read-only and changes no schema, staging, usage or queue. JSON includes effective staging trigger, backlog count/oldest age, queue bytes, last attempt/success/error and connection identity without secrets.
- **Risk:** a repair that reuses an old cursor silently skips the new baseline. Keep diagnosis separate from explicit reset.
- **Size/model:** M; mid-tier safe for schema validation/read-only presentation; success semantics/state scoping require careful review. Depends on none.

### T02 — Define and implement convergence, cursor and retry contracts

- **Goal:** establish the protocol on which compaction and baseline verification depend. Version envelopes/requests; publish accepted schema versions. Make object identity `(file_id, entity_type, entity_key)` explicit. Include original LWW device plus normalized logical timestamp outside ciphertext; verify it agrees with the decrypted envelope on clients. Add server receive time, file generation and durable per-device applied-cursor acknowledgements. ACK only after local application and cursor persistence. An ACK for a page containing skipped malformed data is forbidden.
- **Files:** `packages/tim-sync-server/src/{storage,tenant-registry,server,quotas}.ts`; `packages/tim-sync-client/src/{client,envelope,sync}.ts`; `packages/tim-core/src/lww.ts`; `packages/tim-store/src/{schema,sync-methods,store}.ts`; sync convergence/tombstone tests.
- **Acceptance:** delayed stale writes and equal-time device conflicts converge regardless of arrival order; edge delete-before-create, delete after differing edge IDs, duplicate replay and stale resurrection tests pass. Persist edge tombstones and original device identity, and apply deletes by composite identity. Replaying an accepted idempotency key returns its stored result before quota checks; same key/different request fails. Quota grouping includes file/type/key and updates replace current logical bytes rather than adding full size twice. Cursor IDs never rewind/reuse; wrong-generation/future cursors fail explicitly. Unknown legacy ordering metadata prevents collection rather than guessing. Schema migration interruption rolls back safely.
- **Risk:** highest data-loss risk; this changes wire/storage contracts. Preserve all ambiguous equal-LWW payloads until conflicting-version behavior is defined. Do not add public key/content leakage beyond the stated metadata contract.
- **Size/model:** L; care required. Depends on T01's identity contract. Split edge convergence, idempotency/quota accounting and cursor protocol into separate reviewed commits.

### T03 — Make the client durable, bounded and single-owner

- **Goal:** serialize push, pull, connect, mirror and config/state mutation across processes; use atomic private state/queue writes and unique temporary files. Prefer one periodic sync owner per DB. Preserve immutable queued versions and acknowledge by exact staged revision/sequence, not wall-clock timestamp alone. Avoid re-enqueueing a staged revision already in the queue.
- **Files:** `packages/tim-sync-client/src/{auto-sync,queue,config,client,sync}.ts`; `packages/tim-store/src/{schema,sync-methods}.ts`; `packages/tim-mcp/src/server.ts`; new client-owner CLI/service adapter and concurrency tests.
- **Acceptance:** simultaneous MCP/CLI/timer invocations, same-millisecond writes, crash after server commit, crash before ack and stale-lock recovery cause no loss or cursor overwrite. Queue/state files are mode 0600 and directories 0700, including replacement of existing files. Byte-bounded batches work with large UTF-8 payloads and encryption expansion; oversized records are identified, not retried forever. Deadlines, 429 backoff, permanent auth/quota errors and nonzero incomplete-cycle exit status work against the hosted server. Idle changes drain without an MCP call.
- **Risk:** atomic rename alone does not prevent lost updates; exact revision identity must survive staging collapse. Disk-full handling must preserve the last durable queue/state.
- **Size/model:** L; care required. Depends on T01–T02. Mid-tier-safe slices: error formatting and deadline/backoff handling once their contracts are fixed.

### T04 — Close secret-node gaps and prove keyless safety

- **Goal:** version the inner encrypted secret payload to include tags and all intended private fields. Treat persisted locked/ciphertext state as authoritative, not a placeholder title. Refuse edits without the secret key at the store boundary and recheck at every push/mirror/legacy-queue boundary. Preserve enough encrypted material to unlock later.
- **Files:** `packages/tim-sync-client/src/{sync,envelope,credentials}.ts`; `packages/tim-store/src/{store,secret,sync-methods}.ts`; `packages/tim-cli/src/secret.ts`; secret-envelope, inherited-secret-push and legacy-secret-queue tests.
- **Acceptance:** an outer-key-only device sees no secret title/content/tags/private metadata; direct and inherited secret nodes behave alike. Rename, metadata/tag patch, removal of a secret marker, subtree moves, queued legacy records and edited placeholders cannot leak or overwrite ciphertext. Existing no-key blocking remains intact. Adding the secret key later restores full content even when the normal pull cursor already passed it; wrong keys fail without advancing cursor. Deletes/edges follow an explicit documented privacy policy. Logs/backups/queue permissions expose no secret values.
- **Risk:** old inner envelopes are a migration format, not plaintext to reinterpret. Opaque placeholders cannot be safely pushed as replacements. Prove behavior with independent clients, including one that lacks the key.
- **Size/model:** L; care required. Depends on T02–T03. This is a gate before uploading real secrets, even though today's owner-only scope reduces the original task's public-service severity.

### T05 — Harden the hosted API and tenant administration

- **Goal:** add explicit host binding, closed registration, proxy trust configuration, endpoint validation, graceful signal handling, request limits and administrative provisioning/rotation/revocation. Hash persisted bearer tokens and redact credentials. Keep physical capacity guards separate from logical quotas.
- **Files:** `packages/tim-sync-server/src/{cli,server,tenant-registry,quotas}.ts`; new administrative CLI module; hosted-server tests; self-hosting docs.
- **Acceptance:** default listener is loopback only; spoofed forwarded headers cannot change limit identity; non-admin cannot register/promote/rotate. Tenant A cannot list/push/pull tenant B's files. Schema/body/key limits, malformed IDs/cursors, slow requests and aborted uploads produce bounded failures. SIGTERM stops acceptance, drains outstanding requests, then closes registry/tenant handles. Redacted logs preserve status/latency/error code. Physical free-space floor rejects growth safely even for pro tenants.
- **Risk:** closing the registry before draining requests and revealing credentials through errors. Do not mistake TypeScript casts for runtime validation.
- **Size/model:** M; mid-tier safe after contract is fixed, with security review. Depends on T02.

### T06 — Package and deploy the private service with systemd

- **Goal:** ship reviewed deployment templates and install a pinned, tested build outside the shared development checkout. Configure tailnet-only Serve -> dedicated nginx -> loopback server, with log limits and restart behavior. Add a serialized client owner timer only after T12's gate.
- **Files:** proposed `deploy/tim-sync/{tim-sync-server.service,nginx.conf,server.env.example,README.md}`; package release scripts; deployed `~/.config/systemd/user/tim-sync-server.service`, `~/.config/tim-sync/server.env`, nginx include/site and additive Serve configuration. These are future edits, not changes made by this audit.
- **Acceptance:** `systemd-analyze --user verify` and nginx validation pass; restart and host reboot restore service; only 8443 is reachable from approved tailnet devices and no TIM endpoint is reachable publicly over IPv4/IPv6. Wrong/absent tenant tokens fail. Existing public sites and Serve port 8556 still work. Test actual rate limits/body/timeouts through the entire proxy chain. Verify compatible Node/native SQLite build and available resource controls.
- **Risk:** port collisions, wrong trusted-proxy assumptions, deploying from mutable `dist`, or accidentally enabling Funnel. Tailnet grants/HTTPS certificate readiness must be checked at execution time.
- **Size/model:** M; mid-tier safe for templates; operator care required for live network/service changes. Depends on T05.

Proposed server unit shape (not installed; `TIM_SYNC_HOST` and registration control are added by T05):

```ini
[Unit]
Description=TIM private sync server
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h/.local/share/tim-sync
ExecStart=/home/bbbee/.nvm/versions/node/v24.14.0/bin/node /home/bbbee/.local/lib/tim-sync/current/packages/tim-sync-server/dist/cli.js
Environment=NODE_ENV=production
Environment=TIM_SYNC_HOST=127.0.0.1
Environment=TIM_SYNC_PORT=3100
Environment=TIM_SYNC_DATA_DIR=/home/bbbee/.local/share/tim-sync
Environment=TIM_SYNC_REGISTRATION_ENABLED=false
EnvironmentFile=%h/.config/tim-sync/server.env
UMask=0077
NoNewPrivileges=true
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Pre-create data/config directories with 0700 and the env file with 0600. The server unit receives only its administrative credential, never client encryption passphrases. Pin the release directory behind `current`, retain the previous release, and validate hardening/resource-control directives against this host's user manager before adding them. Linger is already enabled; do not assume user units can order themselves against system-manager `tailscaled.service`. Ingress can become ready separately, and monitoring must cover that path.

### T07 — Build consistent backups and a proven restore path

- **Goal:** back up registry, all tenant databases, salts, generations, cursor acknowledgements and idempotency results as one recoverable bundle. Use SQLite's online backup API per database, briefly quiescing server mutation/registration/compaction for a consistent bundle manifest. Keep local TIM snapshots independent.
- **Files:** proposed `packages/tim-sync-server/src/{backup,restore}.ts`; admin CLI; `deploy/tim-sync/tim-sync-backup.{service,timer}`; backup runbook. Reuse lessons from `packages/tim-cli/src/snapshot.ts`, not raw live-file copying or its TIM-specific schema assumptions.
- **Acceptance:** hourly local backups, daily encrypted off-host upload, checksum/manifest verification after download, and monthly restore rehearsal. Proposed objectives: local RPO <=1 hour, host-loss RPO <=24 hours, RTO <=2 hours. Retain 48 hourly local bundles, 14 daily off-host bundles and 8 weekly bundles, within a measured byte budget. Never prune the last verified backup or prune because an upload failed. Missing rclone, stale source, incomplete tenant manifest, upload failure and restore failure exit nonzero. Restore to an isolated data directory/port and perform real authenticated pull/decrypt/count/hash verification.
- **Risk:** independently timed registry/tenant copies can form an inconsistent set; WAL sidecars must not be naively copied. Server bundles also contain access-control material. Encrypt the whole bundle with a separate rclone crypt remote and back up its key outside this VPS. Confirm pCloud capacity/credentials in the deployment ticket; not checked here.
- **Size/model:** M; care required for consistency and restore. Mid-tier safe for timer/retention/reporting after API contract is reviewed. Depends on T02, T05–T06.

SQLite documents online backup as a supported live-database mechanism: [SQLite backup API](https://sqlite.org/backup.html). rclone crypt encrypts data before sending it to the configured underlying remote: [rclone crypt](https://rclone.org/crypt/). These are mechanisms; the RPO, retention and rehearsal requirements above are project decisions.

### T08 — Compact tenant history without losing convergence or cursors

- **Goal:** implement a bounded, resumable per-tenant compaction job with dry-run metrics, locking and backup prerequisite. Add `(file_id,id)` pull indexing and indexes for typed object/version lookup. Reclaim superseded history without treating a newer arrival as a newer logical value.
- **Files:** `packages/tim-sync-server/src/{storage,tenant-registry,cli}.ts`; proposed `compaction.ts`; compaction tests; `deploy/tim-sync/tim-sync-compact.{service,timer}`.
- **Algorithm:** retain every object's maximal LWW value, including deletion envelopes and all ambiguous equal-version payloads. Keep original monotonic IDs. Delete only strictly superseded versions older than seven days by **server receive time**, with both candidate and retained replacement behind the minimum durable applied-cursor ACK of registered replicas for that file. Keep records with unknown legacy metadata. Initial version never silently expires a device: an offline device can hold the floor back and must cause a visible warning. Explicit retirement requires revocation/fencing and re-bootstrap before that device can return. New devices start from retained state with the current generation. Never garbage-collect final tombstones in this release.
- **Acceptance:** two caught-up replicas, an offline replica, a fresh replica and a replica midway through pagination converge before/after compaction. Include an earlier-ID LWW winner followed by a later-ID stale write, equal-time device tiebreaks, entry/edge deletes, two files with identical object keys, repeated retries and process death during a batch. Compare decrypted canonical state, not only row counts. Dry-run reports retained/deleted rows and bytes. Autoincrement high-water and generation survive maintenance. Idempotency retention cannot expire a key while its retry remains valid. Physical file reclamation is a separate backed-up maintenance step; ordinary row deletion must not be reported as immediate disk shrinkage.
- **Risk:** very high; age alone, `MAX(id)`, client clock time, or server `deleted_at IS NULL` are not safe collection rules. Encrypted tombstones are in payloads; current server columns do not identify them. Restores use generation changes, not cursor reuse.
- **Size/model:** L; care required. Depends on T02 and T07. Do not turn collection on before its production fixture rehearsal passes.

### T09 — Add monitoring, alert delivery and storage budgets

- **Goal:** report service reachability separately from successful replication, physical growth and backup recovery readiness.
- **Files:** server request instrumentation and admin diagnostics; client audit/status; proposed `deploy/tim-sync/tim-sync-monitor.{service,timer}` and runbook; bounded journal/nginx log configuration.
- **Acceptance:** every minute check systemd plus end-to-end HTTPS/auth readiness; alert after three consecutive failures. Alert when unacked work is older than five minutes, a configured owner has not completed a cycle in ten minutes, secret-blocked work exists, local backup age exceeds two hours, or off-host verified backup age exceeds 26 hours. Track total `.db`/WAL/backup/queue bytes and growth separately from logical quota bytes; warn at 80% filesystem usage, critical at 90% or below 5 GiB free. Report p95 request latency, 5xx/401/402/429 counts, compaction duration/floor lag, restart loops and restore-drill age. Latency initial warning: p95 above two seconds for ten minutes; tune after baseline rehearsal. Inject failures and prove alert recovery/deduplication and bounded logs. Deliver alerts to the existing beeBot route described by the TIM task, with a documented local fallback and an external dead-man check for complete VPS loss.
- **Risk:** “healthy” timestamps can hide permanently queued work; a monitor on the failed machine cannot report total host loss. Alert integration is implementation work, not a message sent during this audit.
- **Size/model:** M; mid-tier safe once metrics are defined. Depends on T01, T06–T08; add client/mirror metrics after T10.

### T10 — Implement safe join, full mirror and verification commands

- **Goal:** add explicit create/join by file ID with server-fetched salt and passphrase verification. Add a resumable baseline path that reads the complete frozen DB and sends encrypted envelopes directly in bounded chunks while staging remains disabled. Add machine-readable verification, not a direct DB-file upload.
- **Files:** `packages/tim-cli/src/{sync-cli,args,cli}.ts`; proposed `packages/tim-sync-client/src/{mirror,verify}.ts`; `config.ts`, `queue.ts`; store snapshot/enumeration API; maintenance/writer-discovery helpers; CLI reference and tests.
- **Proposed commands, not currently available:** `tim sync connect --file-id ... --join`; `tim sync mirror --dry-run`, `tim sync mirror --resume`, `tim sync verify --json`, and `tim sync staging enable|disable`. Final flag design must use protected credential inputs. Do not run these examples against today's CLI.
- **Acceptance:** a DB with no staging history and more than 15,000 entries mirrors fully; rerun resumes without duplicating logical objects or changing LWW timestamps. Include irrelevant/hidden entries, entry and edge tombstones, all metadata, tags, visibility, parents and edge identities. Define the portable-domain manifest explicitly; local usage, FTS/vector caches, logs, queue and session-cache files are excluded as device-local data, not silently lost backup content. Preserve local-only DB contents through separate TIM backups. Use a fresh empty remote file; refuse to bootstrap over unknown preexisting data. An isolated replica with distinct DB/state/queue/device identity pulls the entire file and compares canonical per-object hashes and exact counts by type/state. Parent structure, labels and batch-summary constraints also match. Wrong outer/secret keys and incomplete secret coverage fail verification. Report orphan baseline separately.
- **Risk:** reads against only visible entries omit data; changing IDs/timestamps changes conflict winners. Current `TIM_DB_PATH` does not isolate global `~/.tim` sync state; implement explicit per-replica state paths before using scratch DBs for network tests. Existing hard-deleted edges cannot be reconstructed from staging-off history; use a new authoritative file generation and never merge an old remote baseline.
- **Size/model:** L; care required. Depends on T01–T04 and T02's tombstone contract. Client/server generations and the manifest format must be documented before coding.

### T11 — Rehearse first mirror and all failure/restore paths

- **Goal:** run the complete sequence on a recent approved TIM snapshot copy, an isolated hosted tenant/data directory and isolated client profiles, leaving live staging disabled.
- **Files:** proposed hosted end-to-end test fixtures/scripts; `docs/sync-operations.md`; evidence artifacts with no secret content.
- **Acceptance:** connect/create/provision pro, mirror, pull into a fresh replica, verify hashes, compact, restore an older server backup into isolation, detect generation mismatch and rebuild correctly. Test large records, auth/quota/429 failures, wrong secret key, interrupted uploads, missing disk capacity and concurrent invocation. Record actual memory, encrypted bytes, mirror duration and expected writer-freeze budget. Verify two clients can create/update/delete entries and edges without resurrection or endless echo. Run relevant Vitest suites in an isolated worktree and then the normal repository build/test checks there; existing tests that alter HOME must never run against live state.
- **Risk:** dev-server-only tests or two “replicas” sharing `~/.tim` can falsely pass. Existing 70 snapshot orphans require an explicit classification before final cutover; no silent repair.
- **Size/model:** M; mid-tier safe to execute established cases; care required to interpret differences. Depends on T06–T10.

### T12 — Connect live DB, mirror, verify, then enable staging

- **Goal:** perform the controlled handover described below, record exact evidence and enable the periodic sync owner. No automatic implementation-agent leap from a passing test into live rollout.
- **Files:** deployment runbook, release/backup/verification manifests; future changes to protected client config/state, `~/.tim/config.json`, user client service/timer. No raw SQL.
- **Acceptance:** every live checklist item below passes; baseline equality is established before staging enable; first staged create/update/delete round trip passes afterward; outage/recovery retains the queue. Observe at least 24 hours of normal operation, with no unexplained backlog, secret leakage, stale telemetry or unbounded growth. The operator records the exact release, file/generation, backup, manifest hashes and rollback point without credentials.
- **Risk:** writes during staging-off mirroring are invisible to incremental catch-up. Enabling only a JSON flag without activating the DB trigger change also creates a gap.
- **Size/model:** M; care required/operator execution. Depends on all prior gates.

## 4. Live cutover checklist and rollback

### What must be verified before changing staging

1. **Identity and state:** `tim sync audit --json` (T01, new) resolves exactly `/home/bbbee/.tim/tim.db`, confirms schema compatibility and reports the effective DB staging trigger disabled. Inventory every process using this DB: HTTP/stdio MCP, hooks, CLI writers, summarizer, timers and agents. Do not assume stopping the singleton stops all writers. Record current client config/state and queue paths privately. Quarantine the blank configuration and fake state through the new explicit repair/connect operation; do not merely edit its file ID.
2. **Readiness:** deploy the tested release, verify private ingress/auth, provision Benni's tenant as pro and create an empty remote file with a new generation. Verify outer and secret passphrase availability and recoverability. Run `tim secret list` and `tim secret status <id>` through CLI as appropriate; new audit must include inherited secrecy and locked placeholders that `secret list` alone misses. These diagnostics must be updated to avoid constructor writes when advertised as read-only.
3. **Database baseline:** use `tim doctor`, `tim stats`, and the new read-only sync audit/manifest CLI to establish schema, FTS, referential structure, visible/hidden/tombstoned counts, edge tombstones, file/queue identity, payload sizes and secret coverage. The snapshot's 70 orphan entries are not permission to ignore live differences: classify their exact IDs and whether they block reconstruction. Fix separately through supported TIM APIs or explicitly accept the documented preexisting condition; new broken links/orphans are a stop condition. No direct SQL queries or manual staging inserts/deletes.
4. **Recovery:** create a fresh consistent `tim snapshot --out <protected-cutover-path> --no-symlink` using a dedicated retained location; preserve the exact path/checksum. Confirm the server's verified off-host backup and restore drill, free space and alert delivery. Existing `tim snapshot` is usable; tenant backup is the new server CLI. Never `cp` a live WAL-mode DB as the rollback snapshot.
5. **Writer freeze:** acquire the maintained DB-wide maintenance mechanism, quiesce all discovered writers/auto-sync owners and verify no new writer can enter. Extend existing MCP-focused maintenance guards to CLI/hooks as part of T10. Keep staging disabled throughout baseline upload and verification. If the freeze cannot be held for the measured duration, abort this cutover; do not substitute an untested timestamp catch-up. Any preflight snapshot taken before the freeze must be refreshed after the freeze for the authoritative mirror source.
6. **Mirror and independent verification:** full mirror from the frozen source into the new file, with durable resumable manifest. Pull/decrypt into an isolated replica, compare per-object canonical hashes, counts and structural diagnostics, then compare source manifest again to prove no writes slipped through. Verify the server backup of this baseline and its generation. A successful push count, status 200 or empty staging table does not satisfy this gate.
7. **Enable while frozen:** only after mirror equality, use the proposed `tim sync staging enable` operation to update `sync.staging=true` and activate `setStagingEnabled` through the supported store API. It must confirm the trigger state rather than waiting for an arbitrary next process to open. Ensure no old process/config override can switch it back. Start exactly one owner using the verified file/generation; restart other writers on the tested build/config, then release the freeze.
8. **Prove incremental operation:** through supported TIM APIs/CLI, create, edit, move/tag and delete a disposable test entry and edge; inspect exact staging revisions with the new audit, observe acknowledged push, then pull from the second replica. Test a keyless secret client with synthetic data. Confirm recent success timestamps, stable cursor, zero unintended backlog, and no loop of echoed changes. Exercise a brief service outage: work queues, retries succeed, and no records disappear. Keep baseline/rollback artifacts until the observation period and next restore rehearsal pass.

Several required commands are intentionally proposed work. Current CLI lacks safe full enumeration/hash verification, explicit mirror/join, effective staging inspection and controlled staging activation; implementing these is part of readiness, not a reason to fall back to raw SQL.

### Rollback by phase

- **Before live mirroring:** stop the new client owner/ingress and revert the new release/proxy configuration. Preserve existing Serve 8556 and public sites. Live TIM remains authoritative with staging disabled. Keep failed-server logs/data for diagnosis; no need to restore the source DB.
- **Mirror interrupted, staging still disabled:** keep the writer freeze and resume from the durable manifest, or abandon the incomplete remote file. If local writes must resume, discard that baseline as a cutover candidate and mirror a new frozen snapshot later. Do not enable staging on an incomplete baseline. No source DB restoration is needed for a transport failure.
- **After staging is enabled, remote unhealthy:** pause network sync but **leave staging enabled** so new local edits remain durable. Preserve queue, cursors, tombstones and config. Restore the prior compatible binary/proxy or repair service, then retry. Do not clear the outbox or disconnect blindly. Alert on backlog age/size. If the team deliberately turns staging off for an extended rollback, record the gap and require a new full frozen baseline before the next enable.
- **Compaction/server corruption:** stop ingress, backup/compaction jobs and clients; retain the failed data directory; restore a complete verified registry+tenant bundle into a separate directory and validate it. Repoint only after checks. A restored server can be behind client cursors/acks: bump its generation and make all clients refuse incremental sync until reseeded/reconciled. For today's single authoritative source, create a fresh file/baseline from current TIM instead of trusting already-acked local staging to replay lost server history. For independent devices, preserve and reconcile every device's unsynced state before reseeding; never overwrite them with one older replica.
- **Local DB damaged by pull/schema change:** first stop all writers/sync and preserve the current DB through supported snapshot tooling if possible. Prefer forward recovery/reconciliation of new local edits. If restore is necessary, use `tim restore --from <verified-snapshot> --dry-run`, then the approved restore operation under its maintenance/writer checks; do not manually replace the live DB or unlink WAL files. Existing restore can restart MCP automatically (`packages/tim-cli/src/restore.ts:273`), so keep sync credentials/owner disabled until post-restore reconciliation. A local restore must also reset/reconcile its state/queue generation; do not restore just the DB and reuse a future cursor. `--force` bypasses an age safeguard and requires an explicit cutover runbook decision, not a routine default.
- **Incompatible schema upgrade:** never run an old binary against new schema merely by reverting a symlink. Restore the matching bundle or deploy a forward fix. Preserve current queues and unsynced writes in either case.

## Completion evidence required from the implementation team

Each ticket should close with its commit(s), relevant test results, observed limitations and links to the runbook/evidence. Final rollout evidence must include exact baseline hashes/counts, successful fresh-replica restore, deletion/secret/concurrency acceptance results, private-ingress checks, backup age and restore duration, and the 24-hour monitoring window. Task closure is not “server started.”

Outstanding live checks are the tailnet ACL/HTTPS capability, pCloud upload/restore and available remote space, complete writer inventory, exact live manifest/orphan classification, key custody, and measured freeze duration. These do not block writing this plan; they block T12 until proven. No production-readiness claim is made by this planning audit.
