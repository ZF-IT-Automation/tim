# Implementation Plan — Production-Readiness-Checkliste (offene Punkte)

> Stand 2026-07-10, HEAD `e383210`. Abarbeitungsplan für die offenen Punkte aus
> `docs/production-readiness.md`. Bewusst NICHT in `docs/plans/` — das
> Plan-Moratorium verbietet neue Feature-Pläne; dieses Dokument ist der
> Tilgungsplan der bestehenden Schuld, kein neuer Scope. Alle file:line gegen
> HEAD `e383210` verifiziert (nicht aus fable5 übernommen).
>
> Reihenfolge = Abarbeitungsreihenfolge. Jeder Task ist einzeln mergebar,
> Standard-Pipeline-tauglich (Grill → Implement → Review) und hat eigene
> Akzeptanzkriterien. Kein Task hängt vom nächsten ab.

---

## Task 1: Write + Staging atomar (fable5 P2)

**Problem.** Entry-Insert und Staging-Insert sind zwei separate Statements ohne
gemeinsame Transaktion. Crash/Kill dazwischen → Entry existiert lokal, wird
aber nie gesynct. Genau der stille Datenverlust, den Garantie 1 der
Production-Readiness-Definition ausschließt.

**Ist (verifiziert):**
- `store.write()` — `packages/tim-store/src/store.ts:1285-1286`:
  `this.insertEntrySync(entry); this.insertStagingSync(entry, …);` — nackt
  hintereinander, keine Transaktion.
- `createProject()` — `store.ts:314-332`: Entry-Insert läuft in
  `tx.immediate(label)`, `insertStagingSync` folgt NACH dem Commit außerhalb.
- Weitere neun `INSERT INTO staging`-Stellen (`store.ts:1263,1380,1398,1413,
  1458,1473,1819,1850,2442` — update/delete/link/unlink/tag-Pfade): jede
  einzeln prüfen, ob der zugehörige Entity-Write in derselben Transaktion
  liegt.

**Änderung.**
1. Helper einführen: `private writeEntryWithStaging(entry, timestamp,
   confidence)` — wrappt `insertEntrySync` + `insertStagingSync` in
   `this.db.transaction(…)()`. `write()` nutzt ihn.
2. `createProject()`: `insertStagingSync` in die bestehende `tx`-Funktion
   ziehen (Dup-Check + Entry + Staging = eine Transaktion).
3. Audit der übrigen neun Staging-Inserts; wo Entity-Write und Staging nicht
   in einer Tx liegen → in eine ziehen. Verschachtelte
   `db.transaction`-Aufrufe sind bei better-sqlite3 als Savepoints ok.

**Tests.**
- Unit: `write()` mit einem via Monkeypatch werfenden `insertStagingSync` →
  Entry darf NICHT in `entries` liegen (Rollback-Beweis).
- Gleiches für `createProject()`.
- Bestandssuite grün (Staging-Zähl-Tests in sync-Tests dürfen sich nicht
  ändern — Verhalten identisch, nur Atomizität neu).

**Akzeptanz:** Kein Codepfad schreibt ein Entity ohne im selben
Transaktionsrahmen zu stagen. **Aufwand:** ~2-4h. **Lane:** STANDARD
(tim-store-Kern, viele Callsites).

---

## Task 2: Summarizer-Hot-Path-Trio (fable5 P0-Empfehlung #2)

Drei zusammenhängende Fixes am Write-Pfad der Batch-Summaries — ein Task, weil
sie dieselben Dateien und denselben Testaufbau teilen.

### 2a. finally-Rollup leakt den MCP-Child

**Ist:** `packages/tim-summarizer/src/summarize.ts:283-287` —
```
} finally {
  await callTimTool(client, 'tim_rollup_session_summary', { sessionId });
  await client.close();
  await postSummarizerHandoff(sessionId);
}
```
Wirft der Rollup (z.B. MCP-Verbindung tot — genau dann läuft das finally nach
einem Loop-Fehler), wird `client.close()` nie erreicht: verwaister
stdio-tim-mcp-Child, und der Sekundärfehler maskiert den Originalfehler.

**Änderung:** Rollup in `try/catch` (Fehler loggen via `onMCPError`, nicht
werfen); `client.close()` + `postSummarizerHandoff` in eigenem
`finally`-innerhalb-des-`finally` bzw. sequenziell mit je eigenem catch.

**Test:** Loop wirft nach erstem Batch (Mock-Client, dessen `callTool` beim
Rollup rejected) → `close()` wurde trotzdem aufgerufen (Spy), Originalfehler
propagiert.

### 2b. Lock-TTL == Summarizer-Timeout

**Ist:** `packages/tim-hooks/src/marker.ts:306` `LOCK_TTL_MS = 10 * 60_000`
vs. `packages/tim-hooks/src/session-hooks.ts:33`
`DEFAULT_SUMMARIZER_TIMEOUT_SEC = 600` — exakt gleich. Ein Summarizer, der
den Timeout fast ausschöpft, gilt in der letzten Sekunde als „stale" und
verliert den Lock an einen Konkurrenten, während er noch schreibt.

**Änderung:** TTL aus dem Timeout ableiten statt doppelt pflegen:
`LOCK_TTL_MS = (DEFAULT_SUMMARIZER_TIMEOUT_SEC + 120) * 1000` (2 min Marge —
deckt SIGTERM-Nachlauf). Import-Richtung beachten (session-hooks importiert
marker; Konstante ggf. in ein gemeinsames `constants.ts` heben, um Zyklus zu
vermeiden).

**Test:** statische Assertion `LOCK_TTL_MS > DEFAULT_SUMMARIZER_TIMEOUT_SEC *
1000` als Regressionstest — verhindert, dass die Kopplung je wieder
auseinanderläuft.

### 2c. Duplicate Batch-Nodes: check-then-act ohne Constraint

**Ist:** `packages/tim-store/src/session.ts:487-545` — `writeBatchSummary`
liest existierende Batches (`getChildByKind` + `find(batch_index)`), dann
update-oder-write. Zwischen Read und Write kann ein konkurrierender
Summarizer (nach Lock-Steal aus 2b) denselben Batch anlegen → doppelte
`Batch N`-Nodes, aufgeblähte Counter.

**Änderung:**
1. Struktureller Schutz: partieller UNIQUE-Expression-Index in
   `tim-store/src/schema.ts` (neue Migration):
   `CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_unique ON entries
   (parent_id, CAST(json_extract(metadata,'$.batch_index') AS INTEGER))
   WHERE json_extract(metadata,'$.kind') = '<KIND_BATCH>'
   AND tombstoned_at IS NULL;`
   Vorher Cleanup-Schritt in derselben Migration: existierende Duplikate
   mergen (höchste seq_to gewinnt, Rest tombstonen) — sonst schlägt der
   Index-Aufbau auf Bestands-DBs fehl.
2. `writeBatchSummary`: den Read-Modify-Write-Block komplett in
   `runExclusive`/`db.transaction` legen; UNIQUE-Verletzung abfangen →
   erneut lesen und in den Update-Zweig gehen (idempotent by construction).
3. Dabei den Session-Metadata-RMW mitziehen (fable5 P1 #4): das
   Metadata-Read von `logExchange`/`writeBatchSummary` in dieselbe exklusive
   Transaktion wie das Write-back.

**Tests:**
- Zwei parallele `writeBatchSummary(sessionId, 5, …)` (Promise.all, zwei
  Store-Instanzen auf derselben Datei-DB) → genau EIN Batch-5-Node.
- Migration auf einer Fixture-DB mit vorhandenen Duplikaten → merged, Index
  gebaut, `tim doctor` sauber.

**Akzeptanz Task 2:** Kein Child-Leak bei Rollup-Fehlern; Lock überlebt den
längsten legalen Summarizer-Lauf; doppelte Batch-Nodes sind auf DB-Ebene
unmöglich. **Aufwand:** ~1 Tag (Migration + Concurrency-Tests sind der
Hauptteil). **Lane:** STANDARD, Schema-Change.

---

## Task 3: Marker-Discovery vereinheitlichen + atomare Writes

**Problem.** Drei Komponenten, drei Discovery-Regeln; fünf ungelockte
Writer mit `writeFileSync` — torn reads geben null zurück und der
Summarizer-Trigger fällt still aus. Das ist die Fehlerklasse des
P9999-Cross-Project-Misbinding-Vorfalls.

**Ist (verifiziert):**
- `marker.ts:270-274` hardcodet `walkUp: true, allowHome: true` (ein
  Callsite), `marker.ts:370-376` gated dieselben Optionen per Env
  (`TIM_MARKER_WALK_UP` etc.) — zwei Policies in EINER Datei.
- `tim-summarizer/src/checkpoint.ts` löst CWD-only auf.
- `tim-hooks/scripts/tim-session-start.sh` implementiert Walk-up in Bash.
- Writes: `marker.ts:251` plain `writeFileSync`; dazu Statusline, Stop-Hook,
  `syncNearestProjectMarker`, Session-Rotation-Block im Shell-Script.

**Scope-Entscheidung:** Das volle R9 (CWD-only, Breaking) bleibt Phase 0.7.
Dieser Task macht die *Vorstufe*, die R9 später trivial macht: EINE
Discovery-Implementierung, EINE Write-Funktion — Policy wird Parameter statt
Kopie.

**Änderung.**
1. `discoverMarker(cwd, policy)` als einzige Discovery-Funktion in
   `marker.ts`; Policy-Default zentral (heute: walk-up, wie gelebt — kein
   Verhaltensbruch). Hardcoded-Callsite und Env-Gate-Callsite rufen beide
   diese Funktion.
2. `checkpoint.ts` importiert `discoverMarker` statt eigener CWD-Logik
   (Policy explizit `cwd-only` übergeben, wenn das dortige Verhalten gewollt
   ist — dokumentieren, WARUM es abweicht, oder angleichen).
3. Shell-Script: Walk-up-Bash-Block durch Aufruf eines kleinen Node-Entrys
   ersetzen (`node -e` mit Env-Args wie beim Session-Rotation-Fix vom
   2026-07-10, oder `tim resolve-project`-CLI, die es schon gibt).
4. `writeMarkerAtomic(path, obj)`: Schreiben nach `path + '.tmp.' + pid`,
   dann `fs.renameSync` — rename ist auf POSIX atomar; alle fünf Writer
   (marker.ts ×3, Stop-Hook, Shell-Rotation via Node-Snippet) benutzen ihn.
   Der Lock (`marker.ts:311`, `flag:'wx'`) bleibt wie er ist — der ist
   korrekt.

**Tests.**
- Discovery: Fixture-Verzeichnisbaum, ein Test pro Policy (cwd-only findet
  nicht in Parent; walk-up findet; Home-Grenze respektiert).
- Alle drei Konsumenten (marker-API, checkpoint, session-start.sh via
  bestehendem Script-Test-Harness) lösen im selben Fixture-Baum auf dasselbe
  Ergebnis auf.
- Atomic write: Reader in Schleife während 200 Writes — nie ein
  JSON.parse-Fehler (torn-read-Regression).

**Akzeptanz:** `grep -rn "readdir\|\.tim-project" packages/*/src
packages/tim-hooks/scripts` zeigt genau eine Discovery-Implementierung und
eine Write-Funktion; Verhalten heute unverändert (Walk-up-Default).
**Aufwand:** ~1 Tag. **Lane:** STANDARD (drei Packages + Shell).

---

## Task 4: Doc-Sync `tim-capabilities.md` §8

**Problem.** §8 („Bekannte Probleme & Lücken", `docs/tim-capabilities.md:513`)
listet ≥10 Zeilen, die auf HEAD längst gefixt sind (fable5-Liste: FTS-
Sanitization, Sections-Filter, Label-Uniqueness, Title-Rename,
recordCommit-Aliases, irrelevant-Restore, Schema-Migrationen, hmem-Import,
Health-Orphan-Metrik, LWW-Determinismus). Eine Gap-Analyse gegen dieses Doc
produziert Fehlalarme — das Doc ist als Karte unbrauchbar.

**Änderung.**
1. Jede §8-Zeile gegen HEAD prüfen: gefixt → in eine neue Subsection
   „Behoben (mit Commit-Referenz)" verschieben oder streichen.
2. Die real offenen fable5-Findings eintragen, die §8 nicht kennt
   (HTTP-Multi-Client-Ambient-State, Summarizer-Fallback ohne Retry-Pfad,
   SSE-Connection-Leak, `tim`-bare-default-init, Fehler-Schluck-Cluster).
3. Heutige Fixes nachziehen: Suppression vollständig, `tim_lease` entfernt
   (auch §-Verweise in `tim-design.md:328` und Vision-Paper-Tabelle
   markieren), Envelope-Origin, Pretest-Gates, Tool-Zahl 47.
4. Querverweis auf `docs/production-readiness.md` als lebende Checkliste —
   §8 verweist auf sie statt sie zu duplizieren.

**Tests:** keine (Doku). **Akzeptanz:** Jede §8-Zeile ist entweder auf HEAD
reproduzierbar oder als behoben markiert; Stichprobe von 5 Zeilen durch
Reviewer. **Aufwand:** ~2-3h. **Lane:** SMALL (nur Doku, aber >30 Zeilen
Diff — Review-Pass trotzdem).

---

## Task 5 (blocked): A/B-Experiment

Kein Implementierungs-Task — Protokoll steht in
`docs/production-readiness.md`. **Blocker: Benni wählt 5 reale
Nicht-TIM-Aufgaben aus.** Sobald das da ist: Läufe durchführen, Ergebnis als
`docs/ab-experiment-<datum>.md` committen. Bis dahin gilt: Tasks 1-4 sind
die letzte „Feature"-Arbeit vor dem Experiment; danach entscheidet das
Ergebnis über die Roadmap (Positiv → weiter; negativ → Feature-Stopp +
Ursachenanalyse).

---

## Reihenfolge & Budget

| # | Task | Aufwand | Risiko | Abhängig von |
|---|------|---------|--------|--------------|
| 1 | Write+Staging atomar | 2-4h | niedrig (mechanisch, gut testbar) | — |
| 2 | Summarizer-Trio | ~1 Tag | mittel (Migration auf Bestands-DB!) | — |
| 3 | Marker-Vereinheitlichung | ~1 Tag | mittel (3 Packages + Shell) | — |
| 4 | Doc-Sync §8 | 2-3h | null | sinnvoll NACH 1-3 (sonst zweimal anfassen) |
| 5 | A/B-Experiment | 1 Nachmittag | — | Benni (Aufgabenauswahl) |

Tasks 1-3 sind unabhängig und parallelisierbar (getrennte Worker möglich);
Task 2c und Task 1 berühren beide tim-store — bei paralleler Ausführung
Merge-Reihenfolge festlegen (1 vor 2). Task 4 zuletzt, damit er den
Endzustand dokumentiert.

**Vor jedem Task:** Branch von master, `--no-ff`-Merge zurück, dist
committen (Repo-Konvention), Full-Suite grün als Merge-Gate — das
Pretest-Gate erzwingt frische dists jetzt automatisch.

**Nach Task 4:** Checkliste in `production-readiness.md` aktualisieren.
Bleibt nur noch Zeile „A/B-Experiment" offen → Eskalation an Benni, denn
dann ist production-ready ausschließlich durch ihn blockiert.
