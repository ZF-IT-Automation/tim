# Plan 12 B: Konsolidierung — "Schlaf-Job" (Implementierungsplan)

> Basierend auf Richtungsplan `docs/plans/2026-07-04-plan-12-memory-power.md` §B
> Ziel: Offline-Wartungslauf, der TIMs Gedächtnis verdichtet — Session- und Projekt-Zusammenfassungen updaten, Duplikate erkennen, Decay-Kandidaten listen.

## Architektur

Zwei Stufen — **Stufe 1 deterministisch (kostenlos), Stufe 2 per Summarizer-CLI-Fallback-Chain (bestehende Abos)**. Stufe 1 erzeugt eine Vorschlagsliste (Curation-Queue), Stufe 2 konsumiert sie.

Stufe 1 läuft als `tim consolidate` CLI-Command + optionaler Cron-Job.
Stufe 2 läuft als Erweiterung des bestehenden Summarizers beim Handoff.

## Task 1: Session-Summary updaten (Handoff-Summarizer-Fix)

**Problem (Benni 2026-07-06):** Beim Handoff wird der Summarizer gespawnt, aber Session- und Projekt-Zusammenfassungen werden nicht zuverlässig aktualisiert.

**Lösung:** Summarizer schreibt beim Handoff zwingend:
- `Sessions/<session-id>/Summary` — aktualisiert den Summary-Node der Session
- Projekt-Root — aktualisiert die Projekt-Überschrift (Entry-Count, neueste Activity)

**Files:**
- `packages/tim-summarizer/src/index.ts` — Handoff-Trigger-Erweiterung
- `packages/tim-store/src/session.ts` — `updateSessionSummary` Methode
- `packages/tim-store/src/curate.ts` oder `store.ts` — `updateProjectSummary` Methode

**Acceptance:**
- [ ] Nach `tim_checkpoint(sessionId)` → Session-Summary-Node existiert mit aktuellem Inhalt
- [ ] Nach Handoff → Projekt-Root-Summary zeigt Entry-Count + letzte Activity
- [ ] Idempotent: Mehrfacher Handoff überschreibt nur, kein Duplikat
- [ ] Tests: 3+ neue Tests für Session/Project Summary Update

## Task 2: Near-Dup-Erkennung (Stufe 1)

**Workflow:**
1. `tim consolidate find-duplicates` scannt alle Entries einer Projekt-Range
2. Nutzt `findSimilar()` aus Plan 9 (Text-Ähnlichkeit) + Embedding-Cosine aus Plan 12a
3. Ergebnis: Liste potenzieller Duplikate mit Similarity-Score
4. Schreibt Curation-Queue-Node im Projekt (`kind=curation`, `metadata.consolidation=duplicate`)

**Files:**
- `packages/tim-cli/src/consolidate.ts` — NEU, CLI-Commands
- `packages/tim-store/src/consolidate.ts` — NEU, `findDuplicateCandidates()`

## Task 3: Decay-Kandidaten erkennen (Stufe 1)

**Workflow:**
1. `tim consolidate find-decay-candidates` scannt nach:
   - `accessed_at` älter als 90 Tage UND `access_count` < 3
   - Keine fresh Edges (kein `relates`/`extends` von aktiven Entries)
   - Stale nach Plan 8 (`verified_at` > 30 Tage, kein Agent-Gate)
2. Ergebnis: Vorschlagsliste → Curation-Queue
3. KEIN Auto-Tombstone, nur `irrelevant`-Flag-Vorschlag

**Files:**
- Erweitert `packages/tim-store/src/consolidate.ts`

## Task 4: Curation-Queue verarbeiten (Stufe 2 — Summarizer/LLM)

**Workflow:**
1. Summarizer liest Curation-Queue-Entries beim Handoff
2. Für Duplikate: Merge-Text formulieren, Target-Entry updaten, Source auf `irrelevant`
3. Für Decay: Bestätigung oder Verwerfung
4. Queue-Entry auf `done` setzen

**Nicht in diesem Plan:** Auto-Trigger per Cron (kommt in Plan 12 D "Silbertablett")

## Task 5: `tim consolidate` CLI-Command

```
tim consolidate                   # Kurzform: führt alle Stufen aus
tim consolidate find-duplicates   # nur Duplikat-Scan
tim consolidate find-decay        # nur Decay-Scan
tim consolidate run               # Stufe 1 + Stufe 2 (falls LLM verfügbar)
tim consolidate status            # Zeigt offene Curation-Queue
```

**Files:**
- `packages/tim-cli/src/cli.ts` — neuen Command registrieren
- `packages/tim-cli/src/consolidate.ts` — NEU

## Migrationsnummer

Keine neue Migration nötig — `consolidate.ts` schreibt nur entries + curation-queue (Metadata-Feld `consolidation` im JSON, kein Schema-Change).

## Test-Plan

| Task | Tests | Notes |
|------|-------|-------|
| 1 | 3+ (Session-Summary, Project-Summary, Idempotenz) | Neue Datei `session-summary.test.ts` |
| 2 | 4+ (Dup-Erkennung, Score, Queue-Write, No-False-Positive) | `consolidate.test.ts` |
| 3 | 3+ (Decay-Kandidat, Stale-Filter, Active-Filter) | |
| 4 | 2+ (Queue-Verarbeitung, Merge-Text) | Integration mit Summarizer |
| 5 | 1+ (CLI-Output-Format) | |

## Global Constraints

- Deterministisch zuerst, LLM zuletzt (Stufe 2 nur wenn Stufe 1 Vorschläge hat)
- Nichts wird automatisch gelöscht — nur `irrelevant` + Curation-Queue
- Summarizer nutzt bestehende Fallback-Chain (keine neuen API-Keys)
- Commit-Nachrichten: Conventional Commits
- Tests müssen auf master grün sein (derzeit 653/654 pass)

## Plan-Struktur

```
feature/plan-12b-consolidation from master
├── Task 1: Session-Summary-Update (Handoff-Fix)
├── Task 2: Near-Dup-Erkennung
├── Task 3: Decay-Kandidaten
├── Task 4: Curation-Queue-Verarbeitung (LLM)
└── Task 5: CLI-Command
```
