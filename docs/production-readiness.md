# TIM — Definition „Production Ready" (v1, 2026-07-10)

> Antwort auf REVIEW-contrary-2026-07-10 §4: ohne Definition ist das Ziel
> unabschließbar. Diese Seite IST das Abnahmekriterium. Änderungen an dieser
> Datei sind bewusste Scope-Entscheidungen, keine Nebeneffekte.

## Zielgruppe

**Bennis eigene Agenten-Flotte** (Overseer + Worker über Claude Code, Cursor,
Hermes/Codex auf dem Strato-Server und lokalen Geräten). NICHT: zahlende
Fremde, Public Launch, Multi-Tenant-Betrieb. Alles, was nur für Fremde nötig
wäre (Hosted MCP, Tenant-Isolation, Billing), ist explizit **außerhalb** dieser
Definition — siehe Streichliste.

## Garantien (was „ready" konkret heißt)

1. **Kein stiller Datenverlust im Write-Pfad.** Jeder erfolgreiche
   `tim_write`/`tim_update` ist nach Prozess-Crash noch da; Staging für Sync
   passiert in derselben Transaktion oder gar nicht.
2. **Retrieval respektiert Suppression überall.** Was suppressed ist, taucht in
   keinem Retrieval-Tool auf (search, read, load_project, show,
   section_children, remember). Ausnahme: Management-Pfade (update/delete),
   damit suppressed Inhalte verwaltbar bleiben.
3. **Kein Tool verspricht, was es nicht tut.** Jede Tool-Description ist durch
   mindestens einen Test gedeckt oder das Tool existiert nicht (fable5-Regel:
   „one e2e test per tool-description promise").
4. **Frischer Code wird getestet, nicht alter.** Pretest-Build-Gate lokal und
   Build-vor-Test in CI; committete dist/ dürfen nie stiller Testgegenstand
   sein.
5. **Session-Binding ist injection-sicher und pro Harness getestet**
   (Claude Code, Cursor, Hermes/Codex, Fallback).
6. **Sync verliert keine Origin-Attribution.** LWW-Tiebreak arbeitet mit dem
   Ursprungs-Device, nicht dem empfangenden.

## Nicht-Garantien (bewusst)

- Kein Multi-Tenant, kein Hosted Endpoint, keine Fremdnutzer-Sicherheit.
- TIM-Sync insgesamt darf Beta bleiben (explizite Ausnahme von Benni,
  2026-07-10).
- Kein Schutz gegen lokale Angreifer mit Dateisystemzugriff auf `~/.tim/`.
- Cloud-Summarizer-Datenabfluss ist dokumentiert, nicht verhindert — sensible
  Setups müssen lokalen Summarizer konfigurieren (bis ein Threat-Model-Doc
  anderes beschließt).

## Abnahme-Checkliste

- [x] Pretest-Build-Gate in Root + allen Packages (2026-07-10)
- [x] CI: build → lint → test
- [x] Suppression in allen Retrieval-Pfaden enforced + getestet (2026-07-10)
- [x] `tim_lease` entfernt (unbenutzbar via MCP; „build it or remove it") (2026-07-10)
- [x] Envelope trägt Origin-Device für LWW (2026-07-10)
- [ ] Write+Staging atomar (Transaktion) — fable5 P2, offen
- [ ] Summarizer-Hot-Path-Trio (finally-Rollup, Lock-TTL > Timeout, UNIQUE Batch-Index) — fable5 P0-Empfehlung #2, offen
- [ ] Marker-Discovery auf EINE Policy vereinheitlicht, Writes atomar (tmp+rename) — offen
- [ ] Doc-Sync tim-capabilities.md §8 (≥10 stale Rows) — offen
- [ ] A/B-Experiment durchgeführt und Ergebnis committed — **braucht Benni** (Protokoll unten)

## Policies (ab sofort, Beschluss 2026-07-10)

- **Tool-Freeze:** Kein neues MCP-Tool, solange die Zahl (47 nach
  Lease-Removal) nicht sinkt. Neues Tool nur gegen Entfernung eines alten.
- **Plan-Moratorium:** Kein neues Plan-Dokument in `docs/plans/`, bis die
  offene Checkliste oben leer ist. 24 existierende Pläne sind
  Umsetzungsschuld genug.
- **Streichliste (bis externe Nachfrage real ist):** Plan 12e (Hosted MCP),
  Phase-0.8-Bezahldienst-Teile der Roadmap.

## A/B-Experiment-Protokoll (blocked auf Benni)

Ziel: die Kernthese messen — macht TIM einen Agenten messbar besser als
`CLAUDE.md` + grep?

1. **5 reale Aufgaben** aus Bennis Backlog auswählen (nicht TIM-Entwicklung;
   z.B. Hermes-Fork, o9k, Infra). Benni wählt aus — deshalb blocked.
2. Jede Aufgabe **zweimal** von einem frischen Agenten lösen lassen:
   (a) TIM-MCP aktiv, (b) TIM aus, nur `CLAUDE.md` + git log + grep.
   Reihenfolge pro Aufgabe randomisieren.
3. **Metriken pro Lauf:** Turns bis Lösung, Anzahl Rückfragen, die Benni schon
   einmal beantwortet hatte, Fehlentscheidungen durch fehlenden/veralteten
   Kontext, Wall-Clock.
4. **Ergebnis als `docs/ab-experiment-<datum>.md` committen** — auch (gerade)
   wenn es negativ ausfällt.
5. Fällt es negativ aus: Feature-Stopp und Ursachenanalyse vor jedem weiteren
   Plan. Fällt es positiv aus: Zahlen ins README, These belegt.
