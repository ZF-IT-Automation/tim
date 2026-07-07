# Plan 12 E: Hosted MCP Endpoint (Implementierungsplan)

> Basierend auf `docs/plans/2026-07-04-plan-12-memory-power.md` §E
> Tier 1 „Blind Sync": verschlüsseltes Backup + Multi-Device-Sync mit Tenant-Isolation.

## Task 1: Tenant Isolation

- API-Token-Auth (`Authorization: Bearer <token>`)
- Eine SQLite-DB pro Tenant für Sync-Blobs
- `POST /register` → `{ token, tenant_id, tier }`

**Files:** `packages/tim-sync-server/src/*`

**Tests:** 4+

## Task 2: `tim sync connect` CLI

- `tim sync connect` — registrieren oder bestehenden Token nutzen
- `tim sync disconnect` — lokale sync.json entfernen
- `tim sync status` — erweitert um Tier/Quota

**Files:** `packages/tim-cli/src/sync-cli.ts`

**Tests:** 3+

## Task 3: Tier 1 Blind Sync Quotas

- Free: max 1000 blobs, max 10MB gespeicherte Payload
- Pro: unbegrenzt
- Push abgelehnt mit 402/413 bei Quota-Überschreitung

**Tests:** 3+

## Task 4: Server Health Endpoint

- `GET /health` → `{ ok, uptime_sec, tenant_count, total_entries, total_bytes }`

**Tests:** 2+

## Branch

`feature/plan-12ef`

## Test-Plan: 12 Tests total
