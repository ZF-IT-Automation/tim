# Review: Pläne 7–11 (merged auf master)

**Datum:** 2026-07-04 · **Reviewer:** Claude (Fable 5), /code-review high (8 Finder-Angles + Einzel-Verifikation)
**Scope:** `git diff c3ea295..5747353` — Plan 7 (package-cleanup), 8 (memory-trust), 9 (write-dedup), 10 (usage-feedback), 11 (recall-tools)

**Gesamtbild:** Plan 7 ist sauber (tim-sync/tim-search-Löschung ohne hängende Imports, nichts Lebendiges verloren). Die Findings stecken fast alle in den neuen Features von Plan 8–11. Alle 10 Haupt-Findings sind von unabhängigen Verifier-Agenten am Code bestätigt (CONFIRMED).

---

## Findings (nach Schwere)

### 1. Plan-10-Usage-Ranking ist auf Label-Pfaden ein stilles No-op — CONFIRMED
`packages/tim-mcp/src/server.ts:1865` (auch 1844)

`recordRead` speichert die aufgelöste interne Composite-ID (`device-MMDD-session-ulid`), aber `tim_update`/`tim_link` reichen die Caller-Eingabe (Label wie `L0042`) an `markReferenced` durch → `UPDATE … WHERE entry_id IN (…)` trifft 0 Zeilen, `referenced` bleibt 0, `rankByUsage` degeneriert zur Identitätsordnung. `usage-wiring.test.ts` besteht nur, weil er die interne `entry.id` benutzt.

**Fix:** In beiden Handlern die vom Store zurückgegebene aufgelöste `entry.id` an `markReferenced` geben (je 1 Zeile). Test-Case ergänzen, der per Label liest und updated.

### 2. tim_guard blind bei Umlauten — CONFIRMED
`packages/tim-store/src/store.ts:1426`

`searchFailures` splittet mit `/\W+/` ohne Unicode-Flag → ü/ö/ä/ß sind Trenner. `'Überweisung ausführen'` → `['berweisung','ausf','hren']`; sanitizeFtsQuery quotet exakt (kein Prefix-`*`), FTS5-unicode61 tokenisiert `überweisung` als ein Token → 0 Treffer → falsches `status: 'clear'` auf einem Sicherheits-Check. `titleSimilarity` im selben File macht es akzent-sicher vor.

**Fix:** Split auf `/[^\p{L}\p{N}]+/u` umstellen. Guard-Test mit deutschem Action-Text ergänzen.

### 3. tim_update löscht heimlich verified_at + provenance — CONFIRMED
`packages/tim-store/src/store.ts:1196`

`metadata: patch.metadata ? JSON.stringify(patch.metadata) : existing.metadata` — Komplett-Replace statt Merge. Der kanonische Weg, einen Task auf done zu setzen (`tim_update {metadata:{task:{status:'done'}}}`), wirft die von Plan 8 gestempelten Felder `verified_at` (tim_verify) und `provenance` (Git-Anker) ohne Warnung weg. Das Replace-Verhalten ist alt; neu ist, dass Plan 8/9/10 systemverwaltete Felder in die user-ersetzbare Metadata legen, ohne sie zu schützen.

**Fix (minimal):** In `store.update()` `verified_at`/`provenance` aus dem Bestand übernehmen, wenn der Patch sie nicht explizit setzt (~5 Zeilen). Generelles Merge-statt-Replace wäre ein API-Beschluss, kein Bugfix.

### 4. Stopwords 'office'/'plants' in searchFailures — CONFIRMED
`packages/tim-store/src/store.ts:1420`

Inhaltswörter in der generischen Stopword-Liste: `tim_guard {action:'water the office plants'}` filtert auf `['water']` und verfehlt den passenden E-Entry → falsches `'clear'` genau bei den Themen, die die Wörter benennen.

**Fix:** Beide Wörter streichen; optional deutsche Funktionswörter ergänzen.

### 5. Dedup-Gate scannt ohne Projekt-Scope global — CONFIRMED
`packages/tim-mcp/src/server.ts:1648`

Ohne auflösbaren `parentId` (schema-legal: parentId/where/parentTitle alle optional) ist `dedupScope` undefined → `findSimilar` scannt alle Projekte (Filter store.ts:1399 kurzgeschlossen). Gleicher Titel in fremdem Projekt (Jaccard ≥ 0.6) blockt den Write mit `duplicate_suspected`/isError; nur `force:true` hilft. Generische Titel („Setup", „Next Steps") sind besonders betroffen.

**Fix:** Bei undefined Scope Gate überspringen oder auf Sibling-Scope (gleicher Parent) begrenzen — nie global.

### 6. recordRead-Fehler macht erfolgreiche Reads kaputt — CONFIRMED
`packages/tim-mcp/src/server.ts:1363` (auch 1452, 1490, 1712)

`recordRead` (INSERT + Once-per-Process-GC-DELETE, ohne try/catch) läuft NACH dem Fetch, aber vor der Antwort. SQLITE_BUSY/READONLY/volle Platte → der äußere catch (server.ts:2420) verwirft die bereits geladenen Daten und liefert isError. `TIM_USAGE_RANKING=0` deaktiviert nur das Ranking, nicht das Recording.

**Fix:** `recordRead` best-effort machen (try/catch + Debug-Log) — Telemetrie darf nie einen Read failen.

### 7. Batch-Read spawnt pro Entry einen blockierenden git-Prozess — CONFIRMED
`packages/tim-mcp/src/server.ts:1365` · `trust.ts:41` · `provenance.ts:16,21`

Seit Plan 8 trägt jeder Nicht-Schema-Write `provenance.commit`; `annotateTrust` ruft pro Entry synchron `execFileSync('git rev-list --count …')` — kein Cache, und `TimReadSchemaBase.id` hat **kein** `.max()` (unbegrenztes ID-Array). N Entries = N serielle Spawns auf dem Event-Loop. Zusatz: `captureProvenance` spawnt zwei git-Prozesse pro Write, obwohl der Header „shells out once" behauptet.

**Fix:** Drift pro Commit-Hash memoisieren (Request-/Prozess-Cache), `.max()` aufs ID-Array, ein kombinierter rev-parse beim Write.

### 8. Referenz-Zähler zählt Read-Events statt Zitierungen — CONFIRMED
`packages/tim-store/src/store.ts:1848`

`recordRead` insertet pro Auftauchen eine Zeile (kein Upsert, kein Unique-Constraint auf (entry_id, session_id)); `markReferenced` flippt alle → 3× gelesen + 1× zitiert = Count 3 → Boost 2·log2(4)=+4 statt der dokumentierten +2 (Doc-Kommentar store.ts:1343). Häufig gesurfacte Entries werden systematisch überboostet.

**Fix:** `COUNT(DISTINCT session_id)` in `getReferenceCounts` (Einzeiler, keine Migration) oder Unique-Constraint + INSERT OR IGNORE (sauberer, mit Migration).

### 9. Task-Badge widerspricht tim_show bei Legacy-Einträgen — CONFIRMED
`packages/tim-mcp/src/project-output.ts:130` vs. `server.ts:943`

`entryBadge` liest nur `metadata.task.status`; `resolveEntryTaskStatus` honoriert weiterhin das Legacy-Feld `metadata.status`. Entry `{task:true, status:'done'}`: Projekt-Briefing zeigt `[todo]`, tim_show behandelt ihn als done (Icon, Sortierung, `with:done`). `project-output-badge.test.ts:100` zementiert das widersprüchliche `[todo]`. Erledigte Legacy-Tasks erscheinen im Session-Start als offen.

**Fix:** Eine gemeinsame `resolveEntryTaskStatus`-Funktion für beide Renderer; entscheiden, ob der Legacy-Fallback gilt oder migriert wird — aber einheitlich.

### 10. Staleness-Definition doppelt implementiert, weicht bereits ab — CONFIRMED
`packages/tim-store/src/store.ts:1908` (getHealth-SQL) vs. `packages/tim-mcp/src/trust.ts:31-34` (JS)

SQL vergleicht kontinuierlich (`< cutoff`), JS truncated mit `Math.floor` → permanentes 1-Tages-Band (Alter in (90, 91)), in dem tim_health stale meldet, tim_read aber nicht annotiert. Threshold-Änderungen müssen an zwei Stellen synchron gehalten werden.

**Fix:** Ein gemeinsamer `isStale`-Helper in tim-core (analog zum SCHEMA_KINDS-Move), von beiden konsumiert.

---

## Unter der Kappe (Platz 11+, ebenfalls belegt)

- **project-output „Move" war eine Kopie** (CONFIRMED): `packages/tim-store/src/project-output.ts` existiert noch mit der alten Badge-Logik (`metadata.status || 'todo'`), wird von keiner Produktion importiert, aber von `project-output.test.ts`/`render-depth.test.ts` in tim-store grün gehalten — tote, divergente Kopie mit eigenen Tests. → Löschen inkl. der Tests (die Fälle leben schon in tim-mcp).
- **isTaskMarker akzeptiert jedes Objekt** (PLAUSIBLE): `metadata.task={}` oder `{priority:'high'}` rendert ein spurious `[todo]`.
- **Altitude-Muster (Design, kein Bug):** Trust-Annotation und Usage-Recording sind pro Tool in server.ts verdrahtet — tim_load_project/tim_read_project (der größte Lesepfad!), tim_show, tim_section_children bekommen weder Staleness-Badges noch Usage-Signal; das Dedup-Gate gilt nur für MCP-Writes. Tiefer wäre: Annotation/Recording im Store-Lesepfad, Dedup als `store.write()`-Option.
- **Reuse:** `rowToEntry` existiert 3× (store.ts, curate.ts, tim-migrate/export.ts — dieser Diff musste alle 3 identisch patchen); `touchVerified` hand-rollt den Staging-INSERT statt `insertStagingSync` (Sync-Drift-Risiko); provenance.ts dupliziert den git-Wrapper aus tim-cli/git-commit.ts.
- **Effizienz (klein):** `findSimilar` läuft `getProjectLabel` pro FTS-Kandidat (bis 25× Parent-Chain-Walk pro Write); `searchFailures` eine FTS-Query pro Keyword statt OR-Query; `touchVerified` prepared 3 Statements pro Loop-Iteration; entry_usage-GC läuft nur einmal pro Prozess.

## Empfehlung

Findings 1–3 fixen, bevor auf den Features aufgebaut wird (ein Bugfix-Task: 3 Files + Tests, keine Migration nötig). 4–10 plus „unter der Kappe" als gesammelter Cleanup-Task.
