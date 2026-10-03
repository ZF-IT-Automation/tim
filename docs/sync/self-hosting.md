# Self-hosting the sync server

`tim-sync-server` speaks plain HTTP. Run it on loopback and put a TLS-terminating
reverse proxy in front; never expose the port directly — bearer tokens would cross
the network in cleartext.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TIM_SYNC_HOST` | `127.0.0.1` | Interface to bind. Keep loopback behind a proxy. |
| `TIM_SYNC_PORT` | `3100` | Listen port. |
| `TIM_SYNC_DATA_DIR` | `~/.tim/sync-server` | Tenant registry and per-tenant databases. Back this directory up. |
| `TIM_SYNC_ADMIN_TOKEN` | unset | Enables admin endpoints and detailed `/health`. Long random value. |
| `TIM_SYNC_TRUST_PROXY` | unset | `1` = take the client IP for the registration rate limit from the last `X-Forwarded-For` hop. Set it only when the proxy appends that header; otherwise any client could pick its own IP. |

```bash
TIM_SYNC_TRUST_PROXY=1 TIM_SYNC_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  node packages/tim-sync-server/dist/cli.js
```

## Reverse proxy

Caddy (TLS automatic, appends `X-Forwarded-For`):

```text
sync.example.org {
  reverse_proxy 127.0.0.1:3100
}
```

nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3100;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 10m;
}
```

## Limits that still apply

- Registration is unauthenticated, limited to 5 per hour per client IP, in memory (a restart resets it).
- Sync endpoints have no application rate limit; add one at the proxy if the server is public.
- The server stores every pushed blob (no compaction yet) — watch the data directory size.

The open production gates (compaction, backups, monitoring) are tracked in
[production-plan.md](production-plan.md).
