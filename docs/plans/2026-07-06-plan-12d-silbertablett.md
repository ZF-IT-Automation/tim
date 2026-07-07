# Plan 12 D: Silbertablett — Alles in den Hintergrund (Implementierungsplan)

> Basierend auf Richtungsplan `docs/plans/2026-07-04-plan-12-memory-power.md` §D
> Ziel: TIM liefert proaktiv Kontext, ohne dass der User fragen muss. Drei Hook-Stufen + Zero-Config-Autonomie.

## Architektur

Drei Hook-Stufen am Session-Lifecycle, alle mit Kill-Switch + Timeout-Budget. Hooks liegen in `tim-hooks` und erweitern die bestehende SessionStart-Hook-Infrastruktur. Fehler dürfen NIE den User-Flow blockieren.

## Task 1: SessionStart-Hook mit `tim_delta` erweitern

**Bestand:** SessionStart-Hook existiert bereits, lädt Projekt-Briefing.

**Neu:** Nach dem Briefing `tim_delta` aus Plan 11 aufrufen → "Seit deiner letzten Session hat sich X geändert" als kurze Notiz anhängen. Neue Entries, geänderte Tasks, neue Decisions.

**Files:**
- `packages/tim-hooks/src/session-start.ts` — Hook erweitern
- `packages/tim-hooks/src/delta.ts` — NEU, `getDeltaBriefing()` Helper
- `packages/tim-mcp/src/server.ts` — `tim_delta` muss bereits registriert sein (Plan 11)

**Acceptance:**
- [ ] SessionStart-Briefing enthält Delta-Block (max 5 Zeilen)
- [ ] Kein Delta wenn seit letzter Session nichts passiert ist
- [ ] Timeout 500ms — bei Überschreitung wird Delta übersprungen
- [ ] Tests: 2+ (Delta vorhanden, Delta leer)

## Task 2: UserPromptSubmit-Hook (neur — Hybrid Retrieval-Kontext)

**Neu:** Hook feuert beim User-Prompt-Submit. Führt Hybrid-Retrieval (Plan 12a) über den Prompt-Text aus, top-3-Treffer als Kontext injizieren ("TIM erinnert: ..."), plus `tim_guard`-Treffer (Plan 11) wenn der Prompt nach einer Aktion aussieht, die schon mal schiefging.

**Latenz-Budget:** ~1s, sonst skip. Kill-Switch per Config.

**Files:**
- `packages/tim-hooks/src/prompt-submit.ts` — NEU
- `packages/tim-mcp/src/server.ts` — Hook registrieren
- `packages/tim-store/src/guard.ts` — kann `tim_guard`-Logik wiederverwenden

**Acceptance:**
- [ ] Prompt-Text wird als Retrieval-Query verwendet
- [ ] Top-3 Ergebnisse werden als Kontextzeilen injiziert
- [ ] `tim_guard`-Treffer werden angehängt wenn relevant
- [ ] Bei Latenz > 1s → skip, kein Block
- [ ] Config-Option: `hooks.promptSubmit.enabled: true|false` (default true)
- [ ] Tests: 3+ (Retrieval-Treffer, Guard-Treffer, Timeout-Skip)

## Task 3: Auto-Init (Zero-Config)

**Bestand:** `tim init` existiert bereits für manuelle Einrichtung.

**Neu:** MCP-Server bootstrappt sich beim ersten Connect selbst: 
1. Prüft ob DB existiert → wenn nein, legt sie an (Schema + Migrationen)
2. Prüft Config → wenn keine da, Defaults schreiben
3. `tim init` wird überflüssig — der Server macht alles selbst

**Files:**
- `packages/tim-mcp/src/server.ts` — `onInitialize` Handler erweitern
- `packages/tim-mcp/src/auto-init.ts` — NEU

**Acceptance:**
- [ ] Erster Connect ohne DB → DB wird angelegt + migriert
- [ ] Fehler beim Auto-Init → Server startet trotzdem (Graceful Degradation)
- [ ] Bestehende Setup (DB + Config) → unverändert
- [ ] Tests: 2+ (Neuinit, Bestehend-Skip)

## Task 4: Auto-Projekt

**Neu:** SessionStart-Hook in einem Verzeichnis ohne `.tim-project`:
- Projekt-Node automatisch anlegen (Label aus Repo-/Verzeichnisname)
- Standard-Sections (Tasks, Bugs, Lessons, Ideas, Decisions) aus project-schema
- Falsch angelegte Projekte sind per `irrelevant` reversibel

**Files:**
- `packages/tim-hooks/src/session-start.ts` — erweitern
- `packages/tim-store/src/session.ts` — `ensureProjectForPath()` Methode

**Acceptance:**
- [ ] Verzeichnis ohne `.tim-project` → Projekt wird angelegt
- [ ] Verzeichnis mit `.tim-project` → unverändert
- [ ] Projekt-Label = Verzeichnisname (z.B. "tim" für ~/projects/tim)
- [ ] Tests: 2+ (neues Verzeichnis, bestehendes)

## Task 5: Update-Check (gedrosselt)

**Neu:** Beim SessionStart ein gedrosselter npm-Registry-Versionscheck (max 1×/Tag). Ergebnis als eine Zeile im Briefing: "TIM x.y verfügbar (installiert: x.z) — `npm i -g @…/tim`"

**Files:**
- `packages/tim-hooks/src/update-check.ts` — NEU
- `packages/tim-hooks/src/session-start.ts` — integrieren
- Config: `updateCheck: true|false` (default true)

**Acceptance:**
- [ ] Check läuft max 1×/Tag (Cache in Config)
- [ ] Bei Network-Error → stille skip
- [ ] Output: eine Zeile im Briefing, niemals Block
- [ ] Opt-out per Config
- [ ] Tests: 2+ (neue Version, kein Update, Network-Error)

## Task 6: `tim-explain` Skill

**Neu:** Skill im TIM-Repo, ausgeliefert via npm-Paket. Sagt dem Agenten nur:
- Wo `docs/tim-capabilities.md` liegt
- Wie er Live-Zustand dazuholt (`tim_health`, `tim doctor`, `tim_stats`)
- Dass er bei Diskrepanz der Doku glaubt, die zur installierten Version gehört

**Files:**
- `packages/tim-skills/src/tim-explain.ts` — NEU
- `docs/tim-capabilities.md` — muss existieren (aus Plan 12a/F)

**Acceptance:**
- [ ] Skill ist < 50 Zeilen
- [ ] Agent kann "was kann TIM?" beantworten
- [ ] Tests: 1+ (Skill-Load)

## Task 7: Skills für schwache Modelle

**Neu:** `tim-using`, `tim-remember`, `tim-session-start` als Kurz-Skills. Entscheidungstabelle wann write/read/search, mit je EINEM Beispiel-Call. Max ~50 Zeilen pro Skill.

**Files:**
- `packages/tim-skills/src/tim-using.ts` — NEU
- `packages/tim-skills/src/tim-remember.ts` — NEU
- `packages/tim-skills/src/tim-session-start.ts` — NEU

**Acceptance:**
- [ ] Jeder Skill < 50 Zeilen
- [ ] Beispiel-getrieben, nicht Prosa
- [ ] Keine Tool-Duplizierung der MCP-Descriptions
- [ ] Tests: 3+ (je Skill ein Test)

## Migrationsnummer

Keine neue Migration nötig. Auto-Init und Auto-Projekt nutzen vorhandene `store.ts`-Methoden.

## Test-Plan

| Task | Tests | Notes |
|------|-------|-------|
| 1 | 2+ | Delta-Briefing, Kein-Delta |
| 2 | 3+ | Retrieval, Guard, Timeout-Skip |
| 3 | 2+ | Neuinit, Bestehend-Skip |
| 4 | 2+ | Neues Projekt, Bestehendes |
| 5 | 2+ | Update, No-Update, Network-Error |
| 6 | 1+ | Skill-Load |
| 7 | 3+ | Skills laden |

## Branch-Struktur

```
feature/plan-12d-silbertablett from master
├── Task 1: Delta in SessionStart
├── Task 2: UserPromptSubmit-Hook
├── Task 3: Auto-Init
├── Task 4: Auto-Projekt
├── Task 5: Update-Check
├── Task 6: tim-explain Skill
└── Task 7: Skills für schwache Modelle
```
