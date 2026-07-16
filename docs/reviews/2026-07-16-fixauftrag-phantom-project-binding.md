# Fixauftrag: Phantom-Projekt-Labels in `.tim-project` (P0100 / P8102 / P9xxx)

**Datum:** 2026-07-16
**Typ:** Bugfix
**Repo:** `~/projects/tim` (Branch: master)
**Priorität:** hoch — betrifft Session-Binding jeder Session

## Symptom

1. `.tim-project` in `~/projects/tim` enthält `"project": "P0100"` (version 2, session `d48fc85d-…`, exchanges 0) — **P0100 existiert nicht in der DB**. `tim_load_project(P0100)` → `Project not found: P0100`. FTS-Suche nach P0100: leer.
2. Die Statusline einer anderen Session zeigt **P8102** — ebenfalls kein existierendes Projekt (Labels liegen normal im Bereich P00xx).
3. `tim_doctor` (aktive DB `~/.tim/tim.db`, 10047 Entries):
   - `"Project label already exists: P9001 (ubun-0706-ns-01KWV7…)"` — **30× in 24h**
   - `"Project label already exists: P9002 (ubun-0706-ns-01KWV7…)"` — **28× in 24h**
   - `"Exactly one creation mode is required. Pass an absolute project path … or memoryOnly: true"` — **19× in 24h**
   - 87 Errors/24h gesamt, Rate 3.63/h

## Reproduktion

1. Session in `~/projects/tim` starten (Claude Code, TIM-SessionStart-Hook aktiv).
2. Hook meldet "session bound to P0100", schreibt/aktualisiert `.tim-project` mit diesem Label.
3. `tim_load_project(label="P0100")` → `Project not found`.
4. `bash packages/tim-hooks/scripts/tim-statusline.sh` (bzw. `node packages/tim-cli/dist/cli.js statusline`) zeigt das Phantom-Label kommentarlos an.

## Verdächtige Root-Cause (Hypothese, verifizieren!)

Der SessionStart-/Auto-Init-Pfad **schreibt den Marker, bevor (oder obwohl) die Projekt-Erstellung fehlschlägt**:

- `packages/tim-hooks/src/project-creation.ts` wirft `"Exactly one creation mode is required …"` (19×/24h) — d.h. der Hook ruft die Projekt-Erstellung mit ungültigen Argumenten auf (weder absoluter Pfad noch `memoryOnly`).
- Label-Allokation (`packages/tim-store/src/store.ts:285`, `packages/tim-cli/src/new-project.ts:118/131`) vergibt offenbar Labels, die nie als Projekt persistiert werden → Marker zeigt ins Leere (P0100, P8102).
- Parallel kollidieren Agents (`ubun-0706-ns-*`) wiederholt auf P9001/P9002 → Retry-Loop ohne Backoff/ohne frische Label-Allokation.
- Kontext: Die Commits `bd6037f` ("reject transient bound projects"), `baf186f` ("make project binding recovery safe"), `16c624c`, `9d918b6` haben genau diesen Recovery-Pfad zuletzt angefasst — mögliche Regression oder unvollständiger Fix.

`UNKNOWN — grill this:` Woher genau kommt das Label P0100/P8102 (Allokation vor Create? Stale Marker aus Probe-Import `probe-import-2026-07-16.db`? Fallback-Generator)? Der Worker muss den Schreibpfad des Markers tracen.

## Scope / Anforderungen

1. **Atomarität:** `.tim-project` darf erst geschrieben/aktualisiert werden, wenn das Projekt in der aktiven DB nachweislich existiert (Create erfolgreich ODER Load erfolgreich). Kein Marker mit unverifiziertem Label.
2. **Hook-Aufruf fixen:** `project-creation.ts`-Aufrufer müssen einen gültigen Creation-Mode übergeben (absoluter Projektpfad aus cwd-Walk-up). Die 19 "Exactly one creation mode"-Fehler müssen verschwinden.
3. **Kollisions-Loop:** "label already exists"-Fehler (P9001/P9002, 58×/24h) beheben — bei Kollision neues Label allokieren oder existierendes Projekt binden, nicht endlos retryen.
4. **Recovery für Bestandsschäden:** Session-Start mit Marker auf nicht-existentes Projekt → nicht stumm weiterlaufen; Marker reparieren (Projekt per Pfad auflösen/neu binden) oder klaren Fehler ausgeben. Der bestehende Marker in `~/projects/tim` muss danach auf das echte TIM-Dev-Projekt zeigen.
5. **Statusline härten:** Label vor Anzeige gegen die DB prüfen; unbekanntes Label als solches markieren (z.B. `P0100?` oder `unbound`) statt es als gültiges Binding anzuzeigen.

## Non-Goals

- Keine Schema-/API-Änderungen an `tim_load_project`.
- Keine Migration/Aufräumung der 4628 broken links / 93 orphans (separates Thema).
- Kein Redesign der Label-Vergabe — nur den kaputten Pfad fixen.
- Keine Änderungen am Feature-Branch `feature/idea-promote-coding-task`.

## Verification / Acceptance

1. Frische Session in `~/projects/tim`: Marker-Label existiert in der DB, `tim_load_project` lädt es erfolgreich.
2. Statusline zeigt ein reales Projekt-Label; bei kaputtem Marker einen erkennbaren Unbound-Zustand.
3. `tim_doctor` nach 24h: keine neuen "Exactly one creation mode"- und "label already exists"-Alerts.
4. Regressionstests: Marker-Write nur nach erfolgreichem Create/Load; Kollisionsfall; Recovery bei Phantom-Marker.
5. Bestehende Testsuite bleibt grün (`npm test`, aktuell 153 Files / 1038 Tests).
