# TIM — Was es können soll (und wo es hakt)

> **Theoretically Infinite Memory** — local-first Gedächtnis für KI-Agenten  
> Stand: 2026-07-02 · Projekt P0063 · Repo: `~/projects/tim`

Dieses Dokument beschreibt den **Soll-Zustand** von TIM: was das System leisten soll, wie die Teile zusammenspielen, und wo der aktuelle Code noch hinter der Vision zurückbleibt. Für die vollständige technische Spec siehe [`tim-vision-paper.md`](./tim-vision-paper.md).

---

## Kurzfassung

TIM soll ein Agent **dauerhaft erinnern** — nicht nur die letzten Nachrichten, sondern Entscheidungen, Bugs, Architektur und Projektstand über Wochen und Monate. Dafür kombiniert es:

1. **Long-Term Memory** mit SQLite, Volltextsuche und (geplant) semantischer Suche
2. **Intelligente Hooks**, die im Hintergrund Gespräche loggen, batchen und zusammenfassen
3. **Projektbasiertes Wissen** — jedes Projekt ist ein strukturierter Baum mit Briefing, Handbuch und offenen Tasks
4. **Session-Start-Briefing** — beim Öffnen einer Session bekommt der Agent sofort den richtigen Kontext
5. **Sync & Sharing** — Wissen zwischen Geräten, Harnesses und (perspektivisch) Providern teilen
6. **Intuitive MCP-Tools** — Agenten holen sich Wissen mit wenigen, selbsterklärenden Aufrufen, ohne SQL, ohne Boilerplate
7. **Automatische Verknüpfungen** — Tags, Edges und Embeddings liefern beim Abruf einer Node passende „Erinnerungen mit"

TIM ist **agenten-unabhängig** (MCP-Standard) und **Framework-unabhängig** vom o9k/Hermes-Orchestrierungslayer — Memory und Orchestrierung sind getrennte Produkte.

---

## 1. Long-Term Memory

### Kernidee

Jeder Agent verliert nach wenigen Minuten den Kontext der letzten Woche. TIM persistiert Wissen in `~/.tim/tim.db` — eine lokale SQLite-Datenbank mit Volltextindex (FTS5). Kein Server nötig; Sync ist optional.

**„Theoretically Infinite"** heißt nicht „unbegrenzt groß im RAM", sondern:

- **Roh-Exchanges** (User/Agent-Nachrichten) werden nie gelöscht, höchstens kalt komprimiert/ausgelagert
- **Abgeleitetes Wissen** (Summaries, Lessons, Confidence-Scores) darf komprimiert werden
- Skalierung über Cold-Node-Kompression, Sharding pro Projekt und Sync-Deltas

### Datenmodell

TIM speichert **Nodes** (Einträge) und **Edges** (Beziehungen) — ein gewichteter Hypergraph, nicht nur ein starrer Baum:

| Typ | Prefix | Zweck |
|-----|--------|-------|
| project | P | Projekt-Wurzel mit Sections |
| task | T | Arbeitspaket mit Status/Priority |
| session | S | Agent-Session mit Exchanges + Summaries |
| bug | B | Fehler mit Repro/Fix-Log |
| lesson | L | Erkenntnis / Lesson Learned |
| decision | D | Architektur-Entscheidung |
| rule | R | Constraint / Konvention |
| idea | I | Brainstorming-Idee |
| commit | C | Git-Commit |
| milestone | M | Meilenstein |
| user | U | User-Profil, Präferenzen |

**Edge-Types** (minimal): `relates`, `extends`, `implements`, `blocks`, `contradicts` — z. B. „Commit implementiert Task", „Bug blockiert Release".

### Drei Schichten „Verwandtschaft"

1. **Explizite Edges** — per `tim_link` gesetzt, sofort sichtbar
2. **Tag-Ähnlichkeit** (TF-IDF) — beim Lesen verwandte Einträge über Hashtag-Overlap
3. **Embedding-Ähnlichkeit** (geplant) — semantische Suche via lokalem ONNX oder API (opt-in)

### Automatische semantische Verknüpfungen — „Erinnerungen mitliefern"

TIM soll **ohne manuelles Verlinken** Kontext anreichern. Der Agent ruft eine Node ab — und bekommt nicht nur den Eintrag selbst, sondern auch **relevante Erinnerungen aus dem Rest der DB**.

**Wie das entsteht (automatisch, im Hintergrund):**

| Mechanismus | Was passiert | Wann aktiv |
|-------------|--------------|------------|
| **Tags** | Summarizer und Agenten taggen Einträge (`#sqlite`, `#sync`, `#bugfix`). Überlappende Tags = semantische Nähe | Beim Schreiben |
| **Tag-TF-IDF** | Seltene Tags wiegen mehr als häufige. Cosine-Ähnlichkeit über IDF-gewichtete Tag-Vektoren | Beim Lesen (`tim_read`, `tim_load_project`) |
| **Explizite Edges** | `tim_link`, Migration aus hmem-Links, `implements`/`contradicts` bei Commits/Tasks | Beim Schreiben |
| **Embeddings** (geplant) | Vektoren pro Node, cosine-similarity ergänzt Tags wo Wortlaut abweicht | On-demand / Hybrid-Search |

**Was der Agent sieht** — Beispiel `tim_read(id="L0042")`:

```
L0042 — „Nie direkt SQL auf tim.db"
├── Body (on demand)
├── children: [...]
├── related_by_tags: [R0010, P0063.12, E0016]   ← automatisch, nach Similarity sortiert
├── related_by_edges: [P0063 → implements]       ← explizite Graph-Nachbarn
└── contradictions: [L0099]                      ← contradicts-Edges
```

Der Agent muss dafür **nichts extra tun** — kein zweites `tim_search`, kein manuelles „gib mir noch verwandte Einträge". Related-Block ist Teil der Read-Response (Budget-gedeckt, damit das Kontextfenster nicht explodiert).

**Design-Prinzipien:**

- **Tags sind das Rückgrat** — jeder Write/Summary soll sinnvolle Hashtags mitbringen; der Summarizer normalisiert Aliase (`#db` → `#sqlite`)
- **Zero extra calls** — Verwandtschaft wird on-read berechnet oder aus gecachtem Index gelesen, nicht per separatem Workflow
- **Rare tags matter** — `#sqlite` verbindet stärker als `#tim`, weil IDF seltene Tags hochgewichtet
- **Transparenz** — Related-Einträge kommen als Summary + ID, nicht als versteckter Prompt-Injection; der Agent sieht, *warum* etwas mitgeliefert wurde (`matched_tags`, `edge_type`)

**Ist-Stand:** Explizite Edges und `tim_trace` funktionieren. Tag-basierte Related-on-Read und `tag_frequency`-Tabelle sind **geplant (Phase 0.7)** — aktuell liefert `tim_read` primär Children und optional Edges, nicht automatisch TF-IDF-Related.

### Negative Memory

Veraltetes oder falsches Wissen soll den Agenten nicht mehr stören:

- `tim_suppress(pattern)` — Einträge aus Suche/Read ausblenden (ohne Löschen)
- `irrelevant`-Flag — Soft-Delete durch Curator/Agent
- `tim_health` — meldet verwaiste Links, stale Suppressions

### Memory Trust

Wissen altert — Codebases bewegen sich, Fakten werden falsch. Plan 8 führt **Staleness** und **Git-Provenance** ein, damit Agenten veraltetes Wissen nicht stillschweigend als aktuell behandeln.

**Staleness-Definition:** Ein Eintrag gilt als veraltet (*stale*), wenn seit dem letzten Vertrauenszeitpunkt mehr als `TIM_STALE_DAYS` Tage vergangen sind (Default: **90**). Der Zeitpunkt ist:

```
verified_at ?? updated_at ?? created_at
```

- `verified_at` — explizite Bestätigung via `tim_verify` (oder manuell in `metadata`)
- `updated_at` — jede inhaltliche Änderung zählt als implizite Re-Verifikation
- `created_at` — Fallback für nie bearbeitete Einträge

Schema-Einträge (`kind` in `SCHEMA_KINDS` — Sessions, Sections, Tasks, …) sind **ausgenommen**: Struktur-Knoten „veralten" nicht.

**`tim_verify`:** Bestätigt Einträge als noch gültig **ohne** Inhalt zu ändern. Setzt `metadata.verified_at`, bumpet `updated_at` und schreibt einen Sync-Staging-Upsert — die Verifikation propagiert wie jede andere Änderung. Entfernt die `stale`-Annotation beim nächsten `tim_read` und senkt `staleEntries` in `tim_health`.

**Provenance bei `tim_write`:** Beim Schreiben von Wissens-Einträgen (nicht Schema-Kinds) erfasst die MCP-Schicht best-effort den aktuellen Git-Stand:

```json
{ "provenance": { "commit": "a1b2c3d", "branch": "main", "captured_at": "2026-07-04T..." } }
```

- `TIM_PROVENANCE=0` — Capture deaktivieren
- Explizites `metadata.provenance` vom Caller wird nicht überschrieben
- Kein Git-Repo, Timeout oder fehlendes `git` → kein Provenance-Feld (kein Fehler)
- Capture nutzt `process.cwd()` des MCP-Prozesses — in **stdio**-Modus das Agent-Workspace; im geplanten HTTP-Multi-Client-Modus (Plan 5) ist der Daemon-cwd bedeutungslos → dort Capture überspringen

**Write-time dedup bei `tim_write`:** Vor dem Insert prüft die MCP-Schicht, ob ein Wissens-Eintrag mit nahezu identischem Titel bereits existiert (FTS-Vorkandidaten + Jaccard-Token-Overlap ≥ **0.6** auf dem Titel). Bei Treffer wird **nicht** geschrieben — stattdessen:

```json
{
  "status": "duplicate_suspected",
  "candidates": [{ "id": "...", "title": "...", "similarity": 0.67 }],
  "hint": "A very similar entry already exists. Append to it with tim_update, or pass force:true to write a new entry anyway."
}
```

(`isError: true` auf der MCP-Response.)

| Regel | Detail |
|-------|--------|
| Scope | Projektgebunden, wenn `parentId` gesetzt — nur Duplikate im selben Projekt zählen |
| Schema-Kinds | **Ausgenommen** (`kind` in `SCHEMA_KINDS` — Sessions, Exchanges, Batch-Summaries, …) — Pipeline-Writes werden nie blockiert |
| Bypass | `force: true` am `tim_write`-Call schreibt trotzdem |
| Kill-switch | `TIM_DEDUP_CHECK=0` deaktiviert die Prüfung vollständig |

Agenten sollten bei `duplicate_suspected` den Kandidaten per `tim_update` erweitern oder bewusst mit `force:true` einen neuen Eintrag anlegen.

**Read-Annotationen (`tim_read`):** Zusätzliche Felder auf der Response — die gespeicherte Row wird beim Lesen nicht verändert:

| Feld | Bedeutung für Agenten |
|------|----------------------|
| `stale` | `{ lastVerified, daysSince }` — Eintrag älter als Schwellwert. Vor Vertrauen: `tim_verify` oder Inhalt prüfen und ggf. `tim_update` |
| `provenance_drift` | `{ commitsSince: N }` — seit dem Write sind N Commits auf dem aktuellen Branch gelandet. Code-Kontext hat sich bewegt → Fakten gegen aktuellen Stand re-checken |

Beide Annotationen können gleichzeitig auftreten. Fehlen sie, ist der Eintrag weder stale noch drifted (oder Schema-exempt).

**`tim_health` — `staleEntries`:** Zählt nicht-schema Einträge, deren `verified_at ?? updated_at ?? created_at` älter als `TIM_STALE_DAYS` ist. Erscheint auch in `issues` als `"N stale entries (older than 90d, unverified)"`. Zusammen mit `tim_verify` und gezieltem Curating ein Ops-Signal für vernachlässigtes Wissen.

### Retrieval Usage-Feedback Loop

TIM lernt aus seinem eigenen Traffic, welche Einträge tatsächlich nützlich sind. Die Messung ist **device-local** — sie verlässt die Maschine nie, wird nicht gesynct und nicht exportiert. Ranking-Boosts sind eine Ranking-Hilfe, keine globale Wahrheit.

**Was zählt als Read:** Jeder `tim_read` (alle drei Pfade: Batch, Project-Pfad, Single-ID) sowie Treffer aus `tim_search`. Pro Eintrag wird eine Zeile in `entry_usage` (Session-ID + Timestamp) angelegt. Reads sind idempotent — derselbe Eintrag in derselben Session erzeugt keine zweite Zeile.

**Was zählt als Reference:** `tim_update`, `tim_link` und das Zitieren einer Entry-ID im Body eines späteren `tim_write` — **nur wenn alle drei in derselben Session passieren wie der Read**. Ein Eintrag der gelesen aber nie benutzt wurde, bekommt keine Referenz. Andere Sessions ohne vorherigen Read sind no-ops.

**Ranking-Formel:** `score = ftsPosition − 2·log2(1 + referencedCount)` (ascending). Eine Referenz hebt um ~2 Positionen, 3 Referenzen um 4, 7 Referenzen um 6. Deterministisch — kein Wallclock-Decay, kein Randomness. Sucht mit `TIM_USAGE_RANKING=0` deaktiviert den Re-Rank vollständig (Recording läuft weiter).

**Opportunistischer GC:** `recordRead` löscht beim ersten Aufruf pro Prozess `entry_usage`-Zeilen älter als 180 Tage. Kein Cron, keine Migration — der GC lebt im Read-Pfad.

**Privacy:** `entry_usage` hat **keine** `staging`-Trigger und ist aus `tim_export` ausgeschlossen. Grep-Beweis nach jedem Change: `grep -rn "entry_usage" packages --include="*.ts" | grep -E "(staging|sync|export)"` muss leer sein.

**Für Agenten:** Eine Suchantwort, in der ein unerwarteter Eintrag zuoberst steht, bedeutet: andere Sessions/Maschinen haben ihn als nützlich markiert. Das ist ein schwaches Signal — kein Befehl. Wenn TIM behauptet, etwas sei wichtig, und die Quelle nicht klar, ist `tim_read` mit `include_body=true` der richtige nächste Schritt.

### Lesen mit Kontext-Budget

`tim_read` liefert standardmäßig **Title + Summary**, nicht den vollen Body — spart Kontextfenster. Voller Inhalt nur mit `include_body=true`. `tim_load_project` hat ein **Budget** (default 200 Einträge) mit Truncation-Priorität: Next Steps und offene Tasks zuerst, Roh-Exchanges nie im Briefing.

---

## 2. Intelligente Hooks — Wissen im Hintergrund extrahieren

### Pipeline

```
Agent-Turn
    │
    ├─ pre_llm_call  → Session-Start: Projekt-Binding-Directive injizieren
    │
    ├─ post_llm_call → Exchange in TIM schreiben (user + agent)
    │
    └─ on_session_end / Stop-Hook
           │
           ├─ Batch voll? (default 5 Exchanges)
           │      └─ tim-summarizer async starten
           │
           └─ tim_checkpoint → Session-Integrität prüfen
```

### Was die Hooks leisten sollen

| Hook | Harness | Aufgabe |
|------|---------|---------|
| `tim-session-start.sh` | Hermes, Claude Code, Cursor | `.tim-project` finden → Directive „ruf `tim_load_project` auf" |
| Exchange-Logger | Hermes `post_llm_call` | Jeden Turn als `kind: exchange` unter Session/Exchanges |
| Stop-Hook / Batch-Trigger | Session-Ende | Unsummarized Batches erkennen → Summarizer spawnen |
| Pre-Commit | Git | `tim_record_commit` — Commit unter Projekt/Commits |
| Checkpoint | Session-Ende | `tim_checkpoint` — Rollup + Verify |

### Summarizer (`tim-summarizer`)

Externer CLI-Agent (Haiku, Codex, …) liest Roh-Exchanges und schreibt **Batch-Summaries**:

```
P0063/Sessions/<session>/
├── Summary/
│   ├── Batch 1  (thematische Zusammenfassung, Tags)
│   └── Batch 2
└── Exchanges/
    ├── User msg 1 → Agent reply 1
    └── User msg 2 → Agent reply 2
```

- **Trigger:** automatisch wenn `exchange_count - batches * batch_size >= batch_size`
- **Manuell:** `/tim-handoff` oder `tim_show_unsummarized`
- **Rollup:** `tim_rollup_session_summary` faltet Batches in Session-Summary-Root
- **Tag-Normalisierung** (geplant): `#sqlite` vs `#database` vereinheitlichen

### Marker-Datei `.tim-project`

Rebuildable Cache im Repo-Root:

```json
{
  "project": "P0063",
  "session": "01KT1ABCDEF...",
  "exchanges": 14,
  "batch_size": 5,
  "batches_summarized": 2
}
```

Erstellt durch Handoff, `tim bind-project`, oder `tim hook session-start`. Der **DB-Baum ist autoritativ** — Marker nur für schnelle Hook-Entscheidungen.

### Statusline (Hermes)

`tim statusline --format hermes` zeigt opt-in: aktives Projekt, Batch-Counter (`14/2`), optional Kontext-Füllstand (Privacy: default aus).

---

## 3. Projektbasiertes Wissen — Briefing & Handbuch

### Projekt-Schema

Jedes Projekt (`tim_create_project` / `tim_new`) bekommt einen **Generator-Baum**:

```
P0063 — TIM
├── Overview          — Kurzbeschreibung, Status
├── Context           — Problem, Lösung, Architektur
├── Rules             — Agent-Regeln, Git, Style
├── Codebase          — Module, Signaturen, Pipeline (Handbuch)
├── Usage             — Install, CLI, MCP
├── Tasks             — offene Arbeit (metadata.task.status)
├── Bugs              — bekannte Fehler
├── Ideas             — Brainstorming
├── Decisions         — Architektur-Log
├── Roadmap           — Phasen
├── Next Steps        — was als Nächstes
├── Log               — Chronik (render_tail)
├── Sessions          — Session-Bäume (render_depth: 0)
└── Commits           — Git-Historie (render_tail)
```

Das ist gleichzeitig **Briefing** (beim Session-Start) und **Handbuch** (Codebase-Section, Usage, Rules).

### Session-Start — perfektes Briefing

**Ziel:** Agent startet nie blind. Ablauf:

1. Hook findet `.tim-project` im Workspace (oder `TIM_PROJECT` env)
2. Directive: `tim_load_project(label="P0063")` — bindet Session ans Projekt
3. `load_project` liefert strukturiertes Briefing:
   - Projekt-Summary + Metadata
   - Offene Tasks (todo/in_progress)
   - Offene Bugs
   - Pinned Rules
   - Letzte Session-Summaries (nicht Roh-Exchanges)
   - Next Steps
   - Truncation-Hinweis wenn Budget erreicht (`_truncated: true`)

**Cross-Project-Lookup** ohne Re-Binding: `tim_load_project(label="P0048", bind:false)` (ersetzt das deprecated `tim_read_project`) — wirft keinen „session already bound"-Fehler.

### `tim_show` — Unified Overview

Ein Tool für alles Wichtige:

```
tim_show(what="tasks", with="open,urgent")
tim_show(what="bugs", with="open")
tim_show(what="decisions")
tim_show(what="all")
```

### Skills (Agent-Anleitung)

15 geplante `tim-*`-Skills leiten den Agenten:

- `tim-load-project`, `tim-read`, `tim-write`, `tim-search`, `tim-recall`
- `tim-new-project`, `tim-new-task`, `tim-new-error`
- `tim-curate`, `tim-handoff`, `tim-config`

Parallel existieren `o9k-*`-Skills für Framework/Orchestrierung — nicht vermischen.

---

## 4. Wissen teilen — Geräte, Provider, Harnesses

### Zwischen Geräten (TIM-Sync)

**Ziel:** Gleiche `tim.db` auf Laptop, Server, Tablet — E2E-verschlüsselt.

| Feature | Beschreibung |
|---------|--------------|
| Transport | WebSocket + REST, Merkle-Tree-Deltas |
| Verschlüsselung | AES-256-GCM, scrypt Key Derivation |
| Server sieht | Nur Ciphertext + Versionsnummern |
| Konflikte | LWW für Sessions/Exchanges, manual für Rules/Decisions |
| Revocation | Passphrase-Rotation + Per-Node-Key-Rotation |
| Granular Sharing | `shared_keys` — einzelne Nodes mit anderen Usern teilen (read/write, nie delete) |

**Passphrase:** Nie Klartext in Config — OS-Keychain oder `encrypted_passphrase` bevorzugt.

**Auto-Sync:** Nach Session-Ende oder per Cron — braucht device-lokale Passphrase (R0026-Prinzip aus hmem).

### Zwischen Harnesses (Agent-Runtime)

TIM spricht **MCP** — jeder Harness mit MCP-Support kann dieselben Tools nutzen:

| Harness | Integration |
|---------|-------------|
| Hermes | `config.yaml` → tim-mcp, pre/post hooks |
| Claude Code | SessionStart hook + MCP |
| Cursor | inject script + MCP |
| Codex / OpenCode | MCP oder CLI |

Session-Exchanges werden harness-agnostisch geloggt (`metadata.harness`). Projekt-Binding über `.tim-project`, nicht über harness-spezifische Pfade.

### Zwischen Providern / Modellen

| Mechanismus | Was geteilt wird |
|-------------|------------------|
| TIM DB | Persistentes Wissen — provider-unabhängig |
| Summarizer | Beliebiges CLI-Modell (Haiku, DeepSeek, …) liest Exchanges, schreibt Summaries |
| Embedding-Provider | Lokal (ONNX) oder API — opt-in wegen Privacy |
| Leasing (`tim_lease`) | Temporärer Agent-Zugriff auf Entry für Sub-Agents |

**Wichtig:** Roh-Exchanges an Cloud-Summarizer = Datenabfluss. Für sensible Setups: lokaler Summarizer als Default.

### hmem → TIM Migration

`tim migrate --from ~/.hmem/personal.hmem` — Prefixe bleiben (`P0001`), Links werden Edges, O-Entries werden Sessions. Plan-3 bereinigt: Imports schreiben `title` + `body` (gesplittet aus dem ersten Newline), erhalten `updated_at`, legen Sync-Staging-Records an, und Re-Imports mit `deduplicate:true` schreiben geänderte Inhalte tatsächlich in die bestehende Entry (vorher: silent no-op). Legacy `migrate.ts` Engine (zero tests, droppte `metadata.label`) gelöscht; `import.ts` deckt v2 + old Format.

### o9k vs TIM

| o9k (its-over-9k) | TIM |
|-------------------|-----|
| Framework: Skills, Cron, Orchestrierung | Memory: DB, Sync, Search |
| hmem MCP Tools | tim MCP Tools |
| `o9k-session-start` | `tim_load_project` + Hooks |

Beide parallel nutzbar; Übergang über `memory_interface: "tim"` in Config (geplant).

---

## 5. Intuitive Tools — Wissen ohne Aufwand holen

TIMs oberstes DX-Ziel: **Zero Friction**. Ein Agent soll Memory nutzen können, ohne das Datenmodell zu studieren, ohne SQL, ohne zehn Parameter-Kombinationen. Die Tools sprechen die Sprache des Agenten — nicht die der Datenbank.

### Design-Prinzipien

| Prinzip | Bedeutung |
|---------|-----------|
| **Ein Aufruf statt Pipeline** | `tim_load_project(label="P0063")` liefert Briefing + Tasks + Bugs + Rules — kein manuelles Zusammenbauen |
| **Natürliche Eingaben** | Projekt-Labels (`P0063`), Aliase (`o9k`), Section-Namen (`Tasks`), Freitext-Suche — keine ULIDs nötig zum Starten |
| **Sinnvolle Defaults** | `tim_read` → Summary first; `tim_show` → offene Tasks; `tim_search` → FTS; Depth/Budget vorkonfiguriert |
| **Ein Tool pro Intent** | „Was ist offen?" → `tim_show(what="tasks")`. „Projekt laden" → `tim_load_project`. „Suchen" → `tim_search`. Nicht alles durch `tim_read` |
| **Shorthand-Parameter** | `tim_write(where="P0063/Tasks", ...)` statt parentId auflösen; `tim_show(with="open,urgent,#sync")` filtert in einem String |
| **Fehler die helfen** | „Project not found: P0063 — did you mean P0062?" statt SQLite-Fehlercode |

### Typische Agent-Flows (je ein Tool)

```
Session starten     → tim_load_project(label="P0063")
Etwas nachschlagen  → tim_search(query="sync passphrase")
Schnellüberblick    → tim_show(what="all", with="open")
Tief einsteigen     → tim_read(id="P0063.12", depth=2)
Cross-Project       → tim_load_project(label="P0048", bind=false)
Neues Wissen        → tim_write(where="P0063/Learnings", content="...", tags=["#lesson"])
Task anlegen        → tim_write(where="P0063/Tasks", metadata={task:{status:"todo"}})
Verknüpfen          → tim_link(sourceId, targetId, type="implements")
Aufräumen           → tim_update(id, irrelevant=true)  oder  tim_suppress(pattern)
```

### `tim_show` — das Schweizer Taschenmesser

Statt separater Tools für Tasks, Bugs, Ideas, Decisions, Commits:

```
tim_show(what="tasks",   with="open,P0")      # offene Tasks, Priorität P0
tim_show(what="bugs",    with="open,#sync")   # offene Bugs zum Thema Sync
tim_show(what="decisions")                     # alle Entscheidungen im Projekt
tim_show(what="Bugs")                          # Section-Inhalt direkt
```

Ein Parameter `what`, ein Parameter `with` — Agent muss die DB-Struktur nicht kennen.

### `tim_guard` — Pre-Action Negative Memory

Vor riskanten oder teuren Aktionen (Worker-Spawn, Deploy, externes API-Call) prüft `tim_guard` die geplante Aktion gegen bekannte Fehler und Learnings:

```
tim_guard(action="upload PDF to reMarkable via rmapi", project="P0063")
```

**Negative Memory:** Einträge mit `metadata.kind ∈ {error, learning}` oder Tags `#error` / `#learning`. Treffer → `status: "warnings"` mit Entry-IDs zum `tim_read`; kein Treffer → `status: "clear"`.

**Workflow-Hook (o9k):** Ein Pre-Spawn-Hook kann `tim_guard` mit der Worker-Task-Beschreibung aufrufen, bevor Hermes startet — ohne TIM-Repo-Änderung außerhalb dieses Projekts.

### `tim_delta` — Was hat sich seit der letzten Session geändert?

Ergänzung zum vollen `tim_load_project`-Briefing — **kein Ersatz** (LLMs sind stateless; neue Sessions brauchen weiterhin den vollen Load):

```
tim_delta(project="P0063")           # Default: seit letzter Session
tim_delta(project="P0063", since="2026-07-01T00:00:00Z")
```

- **Default-Baseline:** `updatedAt` der vorherigen Session im Projektbaum; Fallback 7 Tage wenn keine Session existiert
- **Cap:** 500 Einträge — darüber ist ein Delta kein Briefing mehr
- **Klassifikation:** `created` / `updated` / `deleted` (tombstoned) relativ zum Cutoff

### `tim_recall` / Skills — wenn ein Tool nicht reicht

Für vage Anfragen („was haben wir letzte Woche zu Sync entschieden?") dispatcht der `tim-recall`-Skill einen Sub-Agenten, der sucht und nur Treffer zurückgibt — der Haupt-Agent bekommt komprimiertes Ergebnis, nicht 50 Roheinträge.

### Was Agenten **nicht** tun sollen

- Kein `sqlite3 ~/.tim/tim.db`
- Kein Raten von ULIDs — Labels und Suche zuerst
- Kein `tim_load_project` mid-session auf anderes Projekt (→ `tim_read_project`)
- Kein manuelles Zusammenklicken von Briefing aus 15 `tim_read`-Calls

---

## 6. MCP-Tools — Überblick

39 Tools in `tim-mcp`. Wichtigste Gruppen:

**Lesen:** `tim_read`, `tim_search`, `tim_guard`, `tim_delta`, `tim_load_project`, `tim_read_project`, `tim_show`, `tim_trace`, `tim_health`, `tim_stats`

**Schreiben:** `tim_write`, `tim_update`, `tim_link`, `tim_tag_add/remove`, `tim_record_commit`, `tim_write_batch_summary`, `tim_rollup_session_summary`

**Session:** `tim_session_start`, `tim_session_log`, `tim_checkpoint`, `tim_show_unsummarized`

**Admin:** `tim_create_project`, `tim_export`, `tim_import`, `tim_sync`, `tim_suppress`, `tim_lease`, `tim_doctor`

**CLI:** `tim init`, `tim doctor`, `tim stats`, `tim sync push/pull/status`, `tim bind-project`, `tim resolve-project`

---

## 7. Architektur (10 Packages)

```
tim-mcp          → 39 MCP Tools
tim-cli          → User-facing Commands
tim-core         → Typen, Config, Interfaces, LWW
tim-store        → SQLite (einziger DB-Touchpoint), FTS5
tim-sync-client  → E2E Encryption, Transport
tim-summarizer   → Batch-Summaries
tim-hooks        → Shell-Hooks, Marker, Checkpoint
tim-migrate      → hmem → TIM
tim-skills       → (geplant) Skill-Integration
```

101+ Tests. Noch **nicht auf npm** — Entwicklung via `git clone` + `npm run build`.

---

## 8. Bekannte Probleme & Lücken (Ist vs Soll)

### Kritisch / aktiv

| Problem | Impact | Status |
|---------|--------|--------|
| **Session-Summary-Rollup** ✅ | Rollup jetzt konvergent — feuert unbedingt bei jedem Summarizer-Exit (auch wenn Run nach write crasht); partial-batch race fixed (späte Exchanges in bereits summarisierten Batches werden neu zusammengeführt) | Gefixt — `9db846e` |
| **Summarizer All-Fail (Heuristic Fallback)** | Wenn alle CLI-Tools der Chain scheitern, schreibt die Heuristic-Fallback einen Q/A-Dump und MARKIERT den Batch als summarisiert — Retry ist damit UNMÖGLICH, schlimmer als ursprünglich dokumentiert. Workaround: Batch-Node manuell löschen oder `update(irrelevant:false)` auf dem parent-Batch | Offen |
| **Doctor Orphan-Metrik** ✅ | Alte Metrik zählte jedes edge-lose Leaf als "orphan" — Live-DB zeigte 7390 "Orphans" bei ~2934 Einträgen (mehr Orphans als Entries = Metrik-Bug). Neu: live Entries deren `parent_id` auf fehlenden oder tombstoned Parent zeigt. Echte Dangling-Parent-Links, keine normalen Tree-Leaves. | Gefixt — Plan 2, Task 2 |
| **Doppelte P0063-Einträge** | `createProject` prüft keine Label-Uniqueness → `read("P0063")` kann falschen Baum laden | Offen |
| **FTS findet Labels nicht** | `tim_search("P0063")` leer — `metadata.label` nicht im FTS-Corpus | Offen |
| **Alias-Validierung** | `recordCommit("o9k")` wirft obwohl Alias existiert — Validation nutzt nicht `resolveProjectLabel` | Offen |
| **P0063 als irrelevant geflaggt** | Migration hat Projekt-Eintrag selbst markiert → Briefing kann leer/kaputt sein | Offen |

### Rendering / API

| Problem | Impact | Status |
|---------|--------|--------|
| `tim_load_project` sections-filter matcht falschen Node | Section-Filter unzuverlässig | Gefixt — Plan 1, Task 4 |
| `tim_read` respektiert `renderDepthLoad`/`renderDepthRead` | Falsche Tiefe — Codebase-Kinder unsichtbar | |
| `tim_update` unterstützt kein Title-Change | Umbenennen nur via neuer Entry + Migration | |
| Walk-up vs CWD-only | Code macht Walk-up, Vision sagt CWD-only — Tests + falsche Projekt-Erkennung | |

### Vision noch nicht implementiert (Phase 0.7+)

| Feature | Phase |
|---------|-------|
| `summary`-Feld + `updated_at` in entries | 0.7 |
| Session als Root-Nodes (nicht unter Project) | 0.7 |
| `.tim-project` CWD-only + `TIM_PROJECT` env | 0.7 |
| Tag-Frequency-Tabelle (IDF on-read) | 0.7 |
| Related-on-Read (automatische Erinnerungen bei `tim_read`) | 0.7 |
| Embedding-Provider lokal + Hybrid-Search | 0.7 |
| `tim-migrate` Rewrite | ✅ Plan-3 done (Sync-Staging + dedup-merge) |
| Summarizer Tag-Normalization | 0.7 |
| load_project Budget/Truncation vollständig | 0.7 |
| E2E-Sync + `encrypted_passphrase` + Keychain | 0.8 |
| Per-Node-Sharing (`shared_keys`) | 0.8 |
| Conflict-Strategy manual/LWW | 0.8 |
| Cold-Node-Kompression | Store-intern, geplant |
| npm publish | 1.0 |

### Transitions / Dual-Stack

| Problem | Beschreibung |
|---------|--------------|
| **hmem + TIM parallel** | Hermes injiziert o9k-startup UND tim-session-start — zwei Stores, TIM-Directive soll authoritative sein |
| **Skills noch o9k-branded** | `o9k-session-start`, `o9k-handoff` — TIM-Skills teilweise noch nicht published |
| **hmem-sync vs TIM-Sync** | Aktuell noch hmem-sync Server (:3100), TIM-Sync-Produkt in Entwicklung |
| **Letzter Sync 24d+** | Sync auf Strato stale — Writes propagieren erst beim nächsten Push |

### Qualität / Ops

| Problem | Beschreibung |
|---------|--------------|
| PID-Lockfile Lebenszyklus | `f7fa8e1` (2026-06-19) hinzugefügt, `84dc7a0` (2026-07-02) entfernt — WAL + `busy_timeout` + systemd-singleton ist die korrekte Koordination für single-host. Lockfile hat legitime stdio-Use-Cases (Summarizer, Tests) gekillt. Dokumentiert, kein offener Work |
| Kein DB-Backup-Primitive | `INVENTORY-FIX-05` — kritisch vor größeren Migrationen |
| Kein `tim_write_many` | Bulk-Entry-Creation nur einzeln |
| Summarizer-Qualität | Tags inkonsistent zwischen Modellen, `tim_show_untagged` für Cleanup |
| Schema-Drift Tags vs Metadata | `#todo`/`#done` deprecated — `metadata.task.status` soll Source of Truth sein, nicht überall migriert |

---

## 9. Roadmap auf einen Blick

| Phase | Fokus | Status |
|-------|-------|--------|
| 0.0–0.5 | Schema, Store, MCP, CLI, Migration, Search, Hooks | ✅ |
| 0.6 | Vision-Paper, Gap-Analyse | ✅ (dieses Doc ergänzt) |
| 0.7 | Embeddings, Session Root-Nodes, CWD-only, Migrate-Rewrite | 🔲 |
| 0.8 | TIM-Sync Public Beta, E2E, Sharing | 🔲 |
| 0.9 | Doku, E2E-Tests, Onboarding | 🔲 |
| 1.0 | npm Release, Getting Started | 🔲 |

---

## 10. Für wen ist TIM?

**Zielgruppe:** AI-Agent-Entwickler — Claude Code, Cursor, Hermes, OpenCode, Codex.

**Nicht-Zielgruppe:** TIM ist kein Chat-UI, kein Projektmanagement-Tool, kein Ersatz für Git/Obsidian. Es ist die **Gedächtnisschicht** unter den Agenten.

**Erfolgskriterium:** User wiederholt nie denselben Kontext. Agent startet mit Briefing, holt sich Wissen mit einem Tool-Aufruf, bekommt beim Lesen automatisch verwandte Erinnerungen mit, lernt im Hintergrund, erinnert sich über Sessions und Geräte hinweg.

---

## Referenzen

- [tim-vision-paper.md](./tim-vision-paper.md) — Vollständige Soll-Spec (37 Tools, 19 Decisions)
- [tim-design.md](./tim-design.md) — Ursprünglicher Architektur-Plan
- [session-system-plan.md](./session-system-plan.md) — Session-Bäume + Summarizer
- [start-hook-plan.md](./start-hook-plan.md) — Session-Start-Hooks
- [tim-cli-reference.md](./tim-cli-reference.md) — CLI-Befehle
- P0063 in TIM — Live-Projektbaum mit Tasks, Bugs, Roadmap
