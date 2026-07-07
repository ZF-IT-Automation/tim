# Plan 12 C: Secret Nodes (Implementierungsplan)

> Secret Nodes — E2E-verschlüsselte Teilbäume
> metadata.secret: true, vererbt via Subtree
> Secret: title+content+metadata clientseitig verschlüsselt (AES-256-GCM/scrypt)
> Struktur (id, parent, timestamps) bleibt klar für LWW-Merge
> Kein Schema-Change — alles per Metadata

## Task 1: `metadata.secret` Feld + Vererbung

- `metadata.secret: boolean` bei Entry-Create/Update setzbar
- `isSecret(entry)` Helper: prüft entry + walkt parent-Kette (Vererbung)
- `ensureSecretInheritance()` beim Create/Move

**Files:** `packages/tim-store/src/secret.ts` NEU

**Tests:** 3+

## Task 2: Sync-Envelope-Verschlüsselung für Secret-Nodes

- Im Sync-Client: vor Envelope-Bau prüfen ob Entry secret ist
- Wenn ja: `content`, `title`, `metadata` mit AES-256-GCM + scrypt-key verschlüsseln
- Struktur-Felder (id, parent_id, created_at, updated_at) bleiben klar
- `is_encrypted: true` Flag im Envelope

**Files:** `packages/tim-sync-client/src/envelope.ts` MOD

**Tests:** 3+

## Task 3: Server-seitiger Index überspringt Secret-Nodes

- Beim Anlegen/Updaten eines Sync-Records: wenn `is_encrypted=true`, KEIN FTS-Index-Eintrag
- Beim Lesen: leeren Platzhalter für encrypted Felder

**Files:** `packages/tim-sync-server/src/sync.ts` MOD

**Tests:** 2+

## Task 4: `tim secret` CLI

- `tim secret set <id>` — setzt metadata.secret=true (vererbt)
- `tim secret status <id>` — zeigt Secret-Status + ob vererbt
- `tim secret list` — alle Secret-Nodes

**Files:** `packages/tim-cli/src/secret.ts` NEU

**Tests:** 2+

## Migrationsnummer: Keine

## Test-Plan: 10 Tests total

## Branch

```
feature/plan-12c-secret
├── Task 1: metadata.secret + Vererbung
├── Task 2: Envelope-Verschlüsselung
├── Task 3: Server-Index-Skip
└── Task 4: CLI
```
