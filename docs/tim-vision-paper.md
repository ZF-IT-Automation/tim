# TIM — Theoretically Infinite Memory
## Vision-Paper v2.0 — Der Soll-Zustand

> **Status:** Final Spec (Phase 0.6) — 2026-06-17
> **Author:** bbbee (Bumblebiber)
> **Source:** 19 Round grill-me Session, Decisions R1–R19
> **Zweck:** Kontextfreies Briefing für zukünftiges kompetenteres KI-Modell,
>   das den bestehenden Code fertig schreibt oder alles neu schreibt.
> **Prior Art:** hmem v1.3.8 (its-over-9k), `~/projects/tim/docs/tim-design.md`,
>   `~/projects/tim/docs/session-system-plan.md`, `~/projects/tim/docs/start-hook-plan.md`
> **Codebase:** `~/projects/tim/` (GitHub: Bumblebiber/tim)
>
> **Wichtig:** Dieses Paper beschreibt den **Soll-Zustand** (Vision). Der aktuelle Code
> in `~/projects/tim/` ist die kanonische Quelle für den Ist-Stand. Wo Paper und Code
> abweichen, markieren `> **Note:** ...`-Blöcke die Design-Weichen.

---

## Inhaltsverzeichnis

1. [Vision — Warum TIM existiert](#1-vision--warum-tim-existiert)
2. [Architektur (10 Packages)](#2-architektur-10-packages)
3. [Nodes — 11 Types + Erweiterbarkeit](#3-nodes--11-types--erweiterbarkeit)
4. [Edges — 5-Types Minimal-Set](#4-edges--5-types-minimal-set)
5. [Connections — Drei-Schichten-Graph](#5-connections--drei-schichten-graph)
6. [Schemas — Type + Tree-Template (Generator-Ansatz)](#6-schemas--type--tree-template-generator-ansatz)
7. [Session-Nodes — Root-Nodes mit Project-Links](#7-session-nodes--root-nodes-mit-project-links)
8. [Session-Logging — Tree + Batch-System + Summarizer](#8-session-logging--tree--batch-system--summarizer)
9. [`.tim-project` Discovery — Streng CWD](#9-timproject-discovery--streng-cwd)
10. [TIM-Sync — E2E-verschlüsselt mit Revocation](#10-tim-sync--e2e-verschlüsselt-mit-revocation)
11. [Config — Alle 13 Keys selbsterklärend](#11-config--alle-13-keys-selbsterklärend)
12. [Statusline — Opt-in per Feld, Privacy-First](#12-statusline--opt-in-per-feld-privacy-first)
13. [Tools — Alle MCP-Tools im Überblick](#13-tools--alle-mcp-tools-im-überblick)
14. [Skills — 15 Published Skills](#14-skills--15-published-skills)
15. [Roadmap — 0.6 → 1.0](#15-roadmap--06--10)
16. [hmem-Migration — `tim-migrate` überarbeiten](#16-hmem-migration--tim-migrate-überarbeiten)
17. [o9k-Abgrenzung — Framework vs. Memory](#17-o9k-abgrenzung--framework-vs-memory)
18. [YAML-Schema-Beispiele](#18-yaml-schema-beispiele)
19. [History-Notes](#19-history-notes)

---

## 1. Vision — Warum TIM existiert

TIM (Theoretically Infinite Memory) ist ein **local-first, selbst-optimierendes
Gedächtnissystem für KI-Agenten**. Es löst das Kernproblem aller AI-Coding-Agents:
Nach 10 Minuten Konversation haben sie den Kontext des letzten Monats vergessen.

**Vision:** Ein Agent, der sich erinnert — nicht nur an die letzten 5 Messages,
sondern an Entscheidungen von letzter Woche, Bugs von letztem Monat, Architektur-
Prinzipien vom Projektstart. Ohne dass der User Dinge wiederholt erklären muss.

**Wichtigste Eigenschaften:**
- **Local-first:** Ein Befehl (`tim init`), eine Datei (`~/.tim/tim.db`). Kein Server.
- **Weighted Hypergraph:** Nicht nur Baum-Struktur (hmems 5-Level), sondern
  typisierte Edges zwischen beliebigen Nodes. `contradicts`, `implements`, `blocks`.
- **Selbst-optimierend:** REM-Sleep (Decay, Compression, Dedup) hält die Datenbank
  schlank — alte, irrelevante Fakten sterben; wichtige bleiben.
- **Sync:** E2E-verschlüsselt über o9k-Sync-Server. Passphrase-Rotation für Revocation.
- **Agenten-unabhängig:** MCP-Standard-Protokoll. Jeder Agent (Claude Code, Cursor,
  Hermes, OpenCode, Codex) spricht MCP.

> **Note:** hmem (its-over-9k) war der Vorgänger. 5439-Zeilen-Store-Monolith,
> keine typisierten Edges, kein Embedding-Support. TIM ist Greenfield-Rewrite
> mit klarer Architektur (10 Packages) und 101+ Tests. Siehe [§16 hm-Migration](#16-hmem-migration--tim-migrate-überarbeiten).

> **Note (Review) — Namens-Widerspruch:** „**Theoretically Infinite** Memory" und
> „REM-Sleep Decay (alte Fakten **sterben**)" beißen sich, und `TIM.md` verspricht
> ausdrücklich „Konversationen werden im **Originalton** erhalten". Auflösen durch klare
> Schichtentrennung: **abgeleitetes Wissen** (Summaries, Lessons, Confidence-Scores) darf
> verfallen/komprimiert werden; **Roh-Exchanges** werden nie gelöscht, sondern nur
> kalt-komprimiert/ausgelagert (R2 „Cold-Node-Kompression" — Mechanik fehlt noch).
> Sonst ist „Infinite" Marketing, das das Decay-Feature direkt widerlegt. Genau hier
> liegt das eigentliche Skalierungsproblem: unbegrenzt wachsende Exchange-Rohdaten.

---

## 2. Architektur (10 Packages)

TIM ist ein Monorepo mit 10 npm-Workspaces (`packages/`). Jedes Package hat genau
eine Verantwortung. Package-Interface ist version-locked. Abhängigkeiten sind
gerichtet (siehe Graph).

```
┌──────────────────────────────────────────────────┐
│                   tim-mcp                         │
│  JSON-RPC MCP Server: 37 Tools, stdio transport  │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│                  tim-cli                        │
│  User-facing CLI: 20+ Commands, Interaktiv      │
└──┬───┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬┘
   │   │     │     │     │     │     │     │     │   
┌──▼┐ ┌▼──┐ ┌▼──┐ ┌▼──┐ ┌▼──┐ ┌▼──┐ ┌▼──┐ ┌▼──┐ ┌▼───┐
│co │ │st │ │sy │ │se │ │mi │ │ho │ │sk │ │su │ │cli │
│re │ │ore│ │nc │ │arc│ │gra│ │oks│ │ill│ │mma│ │(ent│
│   │ │   │ │   │ │h  │ │te │ │   │ │s  │ │riz│ │ry) │
│typ│ │SQL│ │LWW│ │FTS│ │hme│ │MCP│ │TIM│ │er │ │    │
│es,│ │ite│ │+  │ │5 +│ │m→ │ │hooks│-aw│ │bat│ │    │
│int│ │   │ │Me │ │Vec│ │TIM│ │+ma│ │are│ │ch │ │    │
│efa│ │   │ │rkl│ │tor│ │   │ │rker││ski│ │sum│ │    │
│ces│ │   │ │e  │ │   │ │   │ │   │ │lls│ │mar│ │    │
└───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └────┘
```

### Package-Verantwortlichkeiten

| Package | Responsibility | Schlüssel-Dateien |
|---------|---------------|-------------------|
| **tim-core** | Typen, Interfaces, Config. Basis-Package. | `src/types.ts`, `src/config.ts` |
| **tim-store** | SQLite-Driver, CRUD, Migrationen, Staging-Ledger. | `src/store.ts`, `src/session.ts` |
| **tim-sync** | LWW-Register + Merkle-Tree-Diff, Push/Pull/Staging. | `src/sync.ts` (geplant) |
| **tim-sync-client** | Sync-Client: E2E-Encryption, Transport, CLI. | `src/client.ts` (geplant) |
| **tim-mcp** | JSON-RPC MCP Server: 37 Tools, Tool-Registry. | `src/server.ts` |
| **tim-cli** | User-facing CLI: 20+ Commands (init, doctor, stats, checkpoints). | `src/cli.ts` |
| **tim-migrate** | hmem → TIM Migration. **Muss überarbeitet werden** (eigener Task). | `src/migrate.ts` |
| **tim-search** | FTS5 Full-Text Search + Embedding-Vector-Search (Hybrid). | `src/search.ts` |
| **tim-summarizer** | Batch-Summarizer: Exchange-Batches → thematische Summaries, Multi-LLM-Fallback-Chain. | `src/summarizer.ts` |
| **tim-hooks** | Shell-Hooks: Session-Start, Pre/Post-Commit, `.tim-project` Detection, Marker. | `src/marker.ts`, `src/session-hooks.ts` |
| **tim-skills** | Agent-Skills-Integration: TIM-bewusste Skill-Loading, Codebase-Aware Prompts. | `src/skills.ts` (geplant) |

### Abhängigkeitsgraph (gerichtet)

```
tim-core ← tim-store ← tim-search
tim-core ← tim-store ← tim-sync
tim-core ← tim-store ← tim-hooks
tim-store ← tim-mcp
tim-core ← tim-cli
tim-core ← tim-store ← tim-summarizer
tim-core ← tim-migrate
tim-core ← tim-sync-client
tim-store ← tim-skills
```

> **Note (R14):** Die 10er-Paket-Struktur ist im Code schon etabliert.
> Siehe `~/projects/tim/packages/` für den Ist-Stand. `tim-sync-client`
> und `tim-skills` sind teilweise noch geplant (Phase 0.7).

---

## 3. Nodes — 11 Types + Erweiterbarkeit

TIM hat **11 built-in Node-Types**, aber die Liste ist **nicht hard-coded**.
In der Config definiert (`node_types: [list]`), beliebig erweiterbar.

### Built-in Types

| Type | Prefix | Schema | Zweck |
|------|--------|--------|-------|
| **project** | P | Ja | Projekt-Wurzelknoten. Enthält Sections + Sub-Tree. |
| **task** | T | Ja | Work-Item mit Status, Priority, Due-Date. |
| **session** | S | Ja | Agent-Session-Log mit Exchanges + Summaries. |
| **bug** | B | Ja | Bug/Error mit Reproduction + Fix-Log. |
| **lesson** | L | Nein | Learning/Erkenntnis. |
| **user** | U | Nein | User-Profil mit Preferences + Identity. |
| **rule** | R | Nein | Constraint/Konvention/Verbot. |
| **idea** | I | Nein | Brainstorming-Idee. |
| **decision** | D | Nein | Architektur-/Design-Entscheidung. |
| **commit** | C | Ja | Git-Commit mit Hash + Message. |
| **milestone** | M | Nein | Meilenstein mit Deadline. |

> **Note (R5):** Konsistenz mit hmem/o9k-Vergangenheit, aber Flexibilität für
> Custom-Types. Die Config `node_types: [project, task, session, ...]` kann
> um eigene Types erweitert werden. Jeder Type kann via Schema validiert werden.

### Entry-Struktur (SQLite-API)

Jeder Node ist ein Entry in der `entries`-Tabelle:

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `id` | TEXT (ULID) | Eindeutige ID |
| `parent_id` | TEXT | Elternknoten (NULL = Root) |
| `content` | TEXT | Inhalt |
| `content_type` | TEXT | `text`, `json`, `blob` |
| `depth` | INTEGER 1-5 | Hierarchie-Tiefe |
| `confidence` | REAL 0.0-1.0 | Vertrauenswert |
| `created_at` | TEXT (ISO 8601) | Erstellzeit |
| `accessed_at` | TEXT (ISO 8601) | Letzter Zugriff |
| `decay_rate` | REAL | Ebbinghaus-Abfallparameter |
| `visibility` | INTEGER (Bitmask) | Owner (1), Trusted (2), Leased (4), Public (8) |
| `tags` | JSON-Array | Tags |
| `irrelevant` | INTEGER | Soft-Delete |
| `tombstoned_at` | TEXT | Hard-Delete-Marker |
| `metadata` | JSON | Typ-spezifische Felder (kind, status, priority, role, seq, etc.) |

> **Note (Review):** Vier offene Punkte gegenüber `TIM.md`:
> 1. **Kein `summary`-Feld.** `TIM.md` gibt jeder Node eine Summary („Node + Subnodes"),
>    und genau darauf beruht das Lazy-Loading-Verkaufsargument gegen OKF (nur Summaries
>    in den Kontext, Bodies on-demand). Aktuell tragen nur Sessions/Batches Summaries.
>    Empfehlung: `summary TEXT` in die `entries`-Tabelle, und `tim_read` liefert
>    standardmäßig Summary + Children, Body nur per Flag (`include_body`).
> 2. **Kein `updated_at`.** `TIM.md` fordert ein Bearbeitungsdatum; es gibt nur
>    `created_at` + `accessed_at`. `updated_at TEXT` ergänzen (relevant für Sync-LWW).
> 3. **ULID ↔ Kurz-ID undefiniert.** Paper nutzt `P0063`, `S-01JX…` und `01KT…` synonym,
>    ohne die Abbildung zu definieren. Wer vergibt den Zähler `P00XX`, und ist er
>    geräte-/sync-sicher (Kollisionen bei Multi-Device)? Festlegen: ULID = primärer
>    Schlüssel, Kurz-ID = per-Type-Counter (im Metadata, beim Sync gemappt).
>    Nebenbei: `TIM.md` sagt „ULID = Gerät + Zeitstempel" — real ist ULID
>    Zeitstempel + 80 Bit Zufall, *ohne* Geräteanteil. Wenn Geräte-Herkunft gebraucht
>    wird (Sync-Debugging), als eigenes Metadata-Feld `origin_device`.
> 4. **`depth 1-5` widerspricht §1.** §1 nennt hmems 5-Level-Grenze als Rewrite-Grund,
>    aber das Schema cappt weiter bei 5. Entweder Cap entfernen/erhöhen, oder die
>    hmem-Kritik relativieren (der Hypergraph läuft über Edges, der Baum bleibt bei 5).

---

## 4. Edges — 5-Types Minimal-Set

TIM verwendet ein **Minimal-Set von 5 Edge-Types**. Alles andere wird per Tags
abgebildet.

| Edge-Type | Bedeutung | Beispiel |
|-----------|-----------|----------|
| **relates** | Allgemeine Beziehung | Session ↔ Project |
| **extends** | Erweiterung/Verfeinerung | Bug ↔ Fix-Commit |
| **implements** | Implementierung | Commit implementiert Task |
| **blocks** | Blockade | Bug blockiert Release |
| **contradicts** | Widerspruch | Zwei widersprüchliche Entscheidungen |

> **Note (R4):** Ursprünglich waren 9 Edge-Types geplant. Reduziert auf 5,
> weil Tags ohnehin User-Filter sind. 5 Types reichen für 95% der Use-Cases.
> Die Schema-Migration (`tim-migrate`) mapped alte 9er- auf 5er-Set.

### Edge-Struktur

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `id` | TEXT (ULID) | Eindeutige ID |
| `source_id` | TEXT | Startknoten |
| `target_id` | TEXT | Zielknoten |
| `type` | TEXT | Einer der 5 Types |
| `weight` | REAL 0.0-1.0 | Gewichtung (optional) |
| `metadata` | JSON | Zusatzfelder (lease_expiry, etc.) |

> **Gemini Anmerkung:** Wenn eine Node per Decay verfällt oder gelöscht (soft/hard) wird, müssen verknüpfte Edges behandelt werden. Empfehlung: Datenbankseitige Foreign-Key-Kaskadierung (`ON DELETE CASCADE`) oder Filterung verwaister Verbindungen bei der Graph-Traversierung in `tim_trace`.

> **Note (Review):** „5er-Minimal-Set" ist nicht konsistent durchgehalten: §16
> (Migration) führt `leases (optional)` als sechsten Edge-Type, und es gibt das Tool
> `tim_lease` + ein `lease_expiry` im Edge-Metadata. Entscheiden und überall gleich
> ziehen: Ist Leasing ein **Edge-Type** (dann sind es 6) oder ein **Metadata-/Visibility-
> Konstrukt** (dann bleibt es bei 5, und §16 muss korrigiert werden)?

---

## 5. Connections — Drei-Schichten-Graph

Bennis Metapher des "Neuronalen Netzes" zwischen Nodes wird durch drei Schichten
umgesetzt:

### Schicht 1: Explizite Edges (immer aktiv)

Typisierte Beziehungen zwischen Nodes (siehe §4). Werden explizit per `tim_link`
erstellt. Sofort sichtbar, keine Berechnung nötig.

### Schicht 2: Tag-TF-IDF-Similarity (on-read, immer aktiv)

Beim Lesen eines Nodes werden ähnliche Nodes via Tag-Overlap gefunden.
`tim_read(id="P0063")` zeigt neben Children auch "Related by Tags" an.

```
# Jeder Tag t bekommt ein IDF-Gewicht: w(t) = log(N / df(t))
#   N      = Gesamtzahl Nodes
#   df(t)  = Anzahl Nodes mit Tag t
# → seltene Tags wiegen mehr (Bennis Anforderung aus TIM.md).
# Similarity = Cosine über die IDF-gewichteten Tag-Vektoren von A und B:

                   Σ_{t ∈ tags(A) ∩ tags(B)} w(t)²
Similarity(A, B) = ─────────────────────────────────────────────
                   sqrt(Σ_{t ∈ A} w(t)²) · sqrt(Σ_{t ∈ B} w(t)²)
```

> **Note (Review):** Die ursprüngliche Formel war reines Set-Overlap
> (`|A∩B| / max(...)`) und ignorierte, dass seltene Tags mehr aussagen — obwohl
> der Abschnitt „TF-IDF" heißt und `TIM.md` Rare-Tag-Gewichtung explizit fordert.
> Ersetzt durch Cosine über IDF-gewichtete Tag-Vektoren. Offen: `df(t)` muss
> inkrementell gepflegt werden (Tag-Häufigkeitstabelle), sonst ist der On-read-Pfad
> bei jedem Lesen O(N).

> **Note (Review):** Embedding-Provider `type: api` (siehe Config) schickt
> Node-Inhalte an einen externen Dienst (OpenAI o. ä.). Für ein E2E-verschlüsseltes
> Memory ist das ein Datenabfluss-Pfad — der **lokale** Provider (`type: local`,
> ONNX) sollte der dokumentierte Default für sensible DBs sein.

### Schicht 3: Embedding-Similarity (on-demand / Pro-Feature)

Optional: Embedding-Provider (lokal via Modell-Datei oder API-Key) erzeugt
Vektor-Embeddings pro Node. `tim_search(query="...", mode="semantic")` nutzt
cosine-similarity für semantische Suche.

> **Note (R3):** Schicht 3 ist optional und Pro-Feature. Embedding-Provider
> in der Config. Phase 0.7 implementiert dies.

---

## 6. Schemas — Type + Tree-Template (Generator-Ansatz)

Schemas definieren nicht nur Feld-Constraints, sondern auch **Tree-Templates**:
welche Sub-Node-Types werden auto-erzeugt beim `tim_new type="project"`?

### Schema-Definition

```yaml
# schemas/project.yaml
type: project
description: "Projekt-Wurzelknoten mit Standard-Sections"
tree_template:
  children:
    - title: "Overview"
      metadata: { kind: "section" }
    - title: "Rules"
      metadata: { kind: "section" }
      children:
        - title: "Agent Rules"
        - title: "Git Rules"
        - title: "Style Rules"
    - title: "Next Steps"
      metadata: { kind: "section", task_root: true }
    - title: "Log"
      metadata: { kind: "section", render_tail: true }
    - title: "Decisions"
      metadata: { kind: "section" }
    - title: "Codebase"
      metadata: { kind: "section" }
    - title: "Usage"
      metadata: { kind: "section" }
    - title: "Bugs"
      metadata: { kind: "section" }
    - title: "Roadmap"
      metadata: { kind: "section" }
    - title: "Ideas"
      metadata: { kind: "section" }
    - title: "Tasks"
      metadata: { kind: "section", task_root: true }
    - title: "Sessions"
      metadata: { kind: "sessions-root", render_depth: 0, order: 1000 }
    - title: "Commits"
      metadata: { kind: "section", render_tail: true }
edge_constraints:
  allowed_types: [relates, extends, implements, blocks, contradicts]
  default_type: relates
```

> **Note (R6):** Schemas sind Generator-Ansatz: `tim_new(type="project")`
> erzeugt den gesamten Sub-Tree. Nicht jeder Type hat ein Schema. Pro Schema:
> Tree-Template, Defaults, Edge-Constraints. Siehe `~/projects/tim/docs/project-schema.json`
> für das aktuelle Schema-Format.

---

## 7. Session-Nodes — Root-Nodes mit Project-Links

**Breaking Change:** Sessions sind eigenständige Root-Nodes, NICHT mehr Sub-Nodes
eines Projects. Sie verlinken per `implements`/`relates` zu Projekten.

```
S-01JX...  (kind: session, Root-Node)
├── Summary     (kind: session-summary-root, tagged #session-summary)
│   ├── Batch 1 (kind: batch-summary)
│   └── Batch 2 (kind: batch-summary)
└── Exchanges   (kind: exchanges-root)
    ├── "User message" (kind: exchange, role: user, seq: 1)
    │   └── "Agent response" (kind: exchange, role: agent, seq: 1)
    └── ...
Relates → P0063 (via Edge type: implements)
```

**Warum:**
- Sessions können mehrere Projekte berühren
- Eigener Lifecycle (unabhängig von Project)
- Project-Subtree bleibt sauber (keine Session-Rohdaten in Project-Output)

> **Note (R7):** IM AKTUELLEN CODE sind Sessions noch Sub-Nodes des Projects
> (`P0063/Sessions/<session>`). Der Breaking Change zu Root-Nodes ist geplant
> für Phase 0.7. Siehe `~/projects/tim/docs/session-system-plan.md` für den
> Implementierungsplan.

---

## 8. Session-Logging — Tree + Batch-System + Summarizer

### Architektur

Der aktuelle Code hat folgende Session-Architektur (Sub-Node-Variante):

```
P0063
└── Sessions         (kind: sessions-root, render_depth: 0)
    └── 2026-06-17   (kind: session)
        ├── Summary  (kind: session-summary-root, tagged #session-summary)
        │   ├── Batch 1  (kind: batch-summary)
        │   └── Batch 2  (kind: batch-summary)
        └── Exchanges    (kind: exchanges-root)
            ├── "User" (kind: exchange, role: user, seq: 1)
            │   └── "Agent" (kind: exchange, role: agent, seq: 1)
            └── ...
```

### Batch-System

Exchanges werden in **Batches** zusammengefasst (default: 5 Exchanges pro Batch).
Jeder Batch wird vom **Summarizer** (externer CLI-Agent) thematisch zusammengefasst.

**Trigger:**
1. **Per-Batch:** Sobald `exchange_count - batches_summarized * batch_size >= batch_size`
   → Summarizer wird asynchron gestartet (via Stop-Hook).
2. **Manuell:** User ruft `/tim-handoff` → Summarizer on-demand.

> **Note (R8):** Der aktuelle Stand ist: Sub-Node Sessions mit Batch-System.
> Summarizer läuft async nach Batch-voll. `/tim-handoff` Skill ruft Summarizer
> on-demand. Siehe `session-system-plan.md` §4 für den Data-Flow.

> **Gemini Anmerkung:** Da der Summarizer über die Config unterschiedliche Modelle (z. B. Haiku, DeepSeek-Flash) nutzen kann, besteht die Gefahr inkonsistenter Tags (z. B. `#sqlite` vs. `#database`). Ein Standardisierungs-Schritt im `tim-summarizer` (z. B. Abgleich mit existierenden Tags vor dem Schreiben) ist ratsam.

> **Note (Review) — Privacy:** Der Summarizer schickt **Roh-Exchanges** an eine
> externe CLI/ein externes Modell (Haiku, DeepSeek-Flash). Das ist derselbe Inhalt,
> den TIM-Sync E2E-verschlüsselt — bei einem API-Modell verlässt er also unverschlüsselt
> das Gerät (DeepSeek zusätzlich mit Datenresidenz-Frage). Für privacy-sensible Setups
> sollte ein lokaler Summarizer der empfohlene Default sein, und die Config einen Hinweis
> tragen, welche `cli`/`model`-Werte lokal vs. Cloud sind.

> **Note (Review) — Concurrency:** Der Summarizer läuft als **separater Prozess**
> async, während der Haupt-Agent weiter in dieselbe `tim.db` schreibt. SQLite-WAL erlaubt
> 1 Writer + N Reader, aber zwei Writer-Prozesse brauchen Serialisierung (busy_timeout /
> Retry). Das idempotente `tim_write_batch_summary` deckt Crash-Recovery ab — der
> Schreibkonflikt Haupt-Agent ↔ Summarizer sollte trotzdem explizit spezifiziert werden.

---

## 9. `.tim-project` Discovery — Streng CWD

**.tim-project Discovery KEIN Walk-up. Nur CWD.** Sub-Dirs brauchen explizites
`tim project use <name>`.

**Warum:**
- Streng, null Magie.
- Verhindert falsche Projekt-Erkennung, wenn ein Sub-Dir ein anderes Projekt ist.
- `tim project browse` listet verfügbare Projekte, User wählt.

> **Note (R9):** Der AKTUELLE CODE (`start-hook-plan.md`) hat einen Walk-up
> (`findMarker` in `marker.ts`). Die Entscheidung ist noch nicht umgesetzt —
> das ist ein geplanter Breaking Change für Phase 0.7. Der Walk-up war eine
> pragmatic Entscheidung während der Implementierung; Benni hat später auf
> CWD-only entschieden.

> **Gemini Anmerkung:** CWD-only ist sauber, erhöht aber die Reibung, wenn man in tiefen Sub-Directories eines großen Projekts arbeitet. Eine CLI-Convenience (z. B. dass die aktive Shell-Session das Projekt erbt oder ein flüchtiges Cache-File im User-Home die Zuordnung speichert) könnte den Workflow erleichtern.

### Marker-Datei

```json
{
  "project": "P0063",
  "session": "01KT1ABCDEF...",
  "exchanges": 14,
  "batch_size": 5,
  "batches_summarized": 2,
  "summarizer": { "cli": "claude", "model": "haiku" }
}
```

Der Marker wird erstellt durch:
1. **Handoff:** Beim `/tim-handoff` wird das aktive Project in jede berührte
   Repo geschrieben (`tim bind-project --cwd <repo> --label P00XX`).
2. **`tim hook session-start`:** Schreibt bei explizitem Session-Binding.
3. **Manuell/Committed:** `tim bind-project` oder direkt in der Repo committed.

---

## 10. TIM-Sync — E2E-verschlüsselt mit Revocation

### Verschlüsselung

- **AES-256-GCM** für Nutzdaten
- **scrypt** für Key Derivation aus Passphrase
- Jedes Sync-Device hat eigenen Key-Container

### Revocation via Passphrase-Rotation

Wenn der Owner die Passphrase rotiert:
1. Owner rotiert Passphrase → Server kennt nur neue Versionsnummer
2. Clients mit alter Version erkennen Diskrepanz (Config-Version != Server-Version)
3. Alte Clients können nicht mehr entschlüsseln
4. E2E-Verschlüsselung bleibt erhalten — Server sieht nur Versionsnummern, keine Inhalte

### Konflikt-Auflösung

Im seltenen Konfliktfall (zwei Devices schreiben gleichzeitig denselben Node):

1. **Owner-Notification:** Sync-Server broadcastet Conflict-Notification an Owner
2. **Owner-Entscheidung:** "Dein Write oder seins oder merge?"
3. Owner entscheidet via `tim sync resolve <ulid>`

> **Note (R10, R11):** Sync ist noch in Entwicklung (Phase 0.8).
> Der aktuelle Stand: o9k-Sync-Server läuft auf localhost:3100. Push/Pull
> ist implementiert, E2E-Encryption + Revocation sind geplant.

> **Gemini Anmerkung:** Bei intensiver Offline-Arbeit auf mehreren Geräten können viele Konflikte entstehen. Um den User im CLI nicht mit manuellen Entscheidungen zu überfordern, sollte standardmäßig eine Konfliktlösungs-Strategie (z. B. "Last Write Wins für Session-Logs", manuelle Auswahl nur für kritische Nodes wie Configs/Rules) konfiguriert werden können.

> **Note (Review) — Per-Node-Sharing fehlt:** `TIM.md` beschreibt das Teilen
> *einzelner* Nodes (z. B. ein Projekt) mit anderen Usern — konfigurierbar lesend/schreibend,
> **aber nicht löschbar**, via eigener Per-Node-Passphrase unter „shared Nodes" in der Config.
> Das Paper ersetzt das durch Visibility-Bitmask + Lease + Passphrase-Rotation; das
> granulare Per-Node-Key-Sharing und die „nicht löschbar"-Permission fehlen. Beide
> Modelle sind nicht deckungsgleich — klären, welches gilt (Bitmask reicht nicht für
> „teile genau diese eine Node mit User X, ohne ihm die DB-Passphrase zu geben").

> **Note (Review) — Passphrase-Speicherung:** `sync.passphrase: ""` als Klartext in
> `~/.tim/config.json` untergräbt E2E (wer die Datei liest, hat den Schlüssel). Besser:
> OS-Keychain (macOS Keychain, libsecret, Windows Credential Manager) oder beim ersten
> Sync prompten und nur einen scrypt-Salt persistieren, nie die Passphrase selbst.

> **Note (Review) — Branding:** Sync heißt in `TIM.md` „TIM-Sync" (eigener Bezahldienst),
> im Paper aber „o9k-Sync-Server" (Config: `ws://localhost:3100`). §17 ordnet Sync klar
> TIM zu. Einheitlich benennen, sonst ist unklar, ob Sync zu TIM oder o9k gehört.

---

## 11. Config — Alle 13 Keys selbsterklärend

TIM Config (`~/.tim/config.json`) hat 13 Keys:

```yaml
# TIM Config — selbsterklärend, Defaults in Klammern

db_path: ~/.tim/tim.db
# Wann ändern: Custom-Pfad für Multi-User-Setup, NAS, oder portable DB

node_types: [project, task, session, bug, lesson, user, rule, idea, decision, commit, milestone]
# Wann ändern: Custom-Type hinzufügen (z.B. "note", "feature", "epic")

edge_types: [relates, extends, implements, blocks, contradicts]
# Wann ändern: Custom-Edge-Type für spezielle Domain (z.B. "depends_on", "triggers")

embedding_provider:
  type: none          # none | local | api
  model: ""           # Modell-Pfad oder API-Modell-Name
  api_key: ""         # Optional: API-Key
# Wann ändern: Embedding-Feature aktivieren (Phase 0.7)

batch_size: 5
# Wann ändern: Mehr/weniger Exchanges pro Batch (1-50). Weniger = häufigere Summaries

summarizer:
  cli: claude         # Welcher CLI-Agent für Summaries
  model: haiku        # Welches Modell
# Wann ändern: Anderen Summarizer nutzen (cursor, codex, gpt)

sync:
  server: ws://localhost:3100
  passphrase: ""      # Wird bei erstem Sync gesetzt
  version: 1
  auto_sync: false
# Wann ändern: Multi-Device-Sync aktivieren (Phase 0.8)

statusline:
  project: true       # Aktives Project anzeigen
  batch_counter: true # Batch-Status (exchanges/summarized)
  context_level: false # Kontext-Level (erfordert explizite Bestätigung)
  model: false        # Aktuelles Modell
  provider: false     # Aktueller Provider
  db_path: false      # DB-Pfad
  tool_count: false   # Anzahl geladener Tools
# Wann ändern: Status-Felder ein/ausschalten (Privacy beachten)

mcp:
  port: 0             # 0 = stdio, >0 = HTTP-Server-Port
  max_payload_size: 10485760  # 10MB
# Wann ändern: HTTP-MCP statt stdio (z.B. für Remote-Agenten)

hooks:
  pre_llm_call:
    - ~/.hermes/agent-hooks/o9k-startup.sh
    - ~/.hermes/agent-hooks/tim-session-start.sh
  post_llm_call:
    - ~/.hermes/agent-hooks/o9k-log-exchange.sh
  on_session_end:
    - /bin/bash -c 'exec node .../tim-cli/dist/cli.js checkpoint --session "$HERMES_SESSION_KEY"'
# Wann ändern: Custom-Hooks hinzufügen (Notion-Sync, Slack-Notification)

decay:
  enabled: true       # REM-Sleep Decay aktivieren
  interval_hours: 1   # Wie oft Decay läuft
  threshold: 0.1      # Score < threshold → irrelevant
# Wann ändern: Decay deaktivieren für Archiv-Projekte

agent_registry:
  enabled: true
  default_visibility: 1  # 1=Owner, 3=Owner+Trusted, 7=Owner+Trusted+Leased
# Wann ändern: Multi-Agent-Setup, Visibility-Änderungen

logging:
  level: info         # debug | info | warn | error
  file: ~/.tim/tim.log
  max_size_mb: 50
# Wann ändern: Debug-Modus für Fehlersuche
```

> **Note (R15):** 13 Keys, selbsterklärend. `embedding_provider` und `sync`
> sind erst ab Phase 0.7/0.8 relevant. Alle Keys haben sinnvolle Defaults.

---

## 12. Statusline — Opt-in per Feld, Privacy-First

TIM kann in der Hermes-Statuszeile Informationen anzeigen. **Opt-in pro Feld.**

**Konfiguration (siehe Config `statusline`-Block):**
- `project: true` — Aktives Project anzeigen (Default)
- `batch_counter: true` — Batch-Status (exchanges/summarized) (Default)
- `context_level: false` — Kontext-Level (erfordert explizite Bestätigung)
- `model: false`, `provider: false`, `db_path: false`, `tool_count: false`

**Privacy-Regel:** Felder, die Rückschlüsse auf private Daten erlauben
(`context_level` = wie voll ist mein Prompt), sind default aus und brauchen
explizite Bestätigung durch den User.

> **Note (R16):** Statusline ist implementiert via `tim statusline --format hermes`
> CLI-Command. Siehe `~/projects/tim/packages/tim-cli/src/cli.ts`.

---

## 13. Tools — Alle MCP-Tools im Überblick

TIM hat **37 MCP-Tools**, gruppiert nach Phase:

### Read/Query-Tools

| Tool | Beschreibung |
|------|-------------|
| `tim_read` | Entry lesen + Children + optional Edges |
| `tim_search` | FTS5 Full-Text Search (optional hybrid mit Embedding) |
| `tim_trace` | Edge-Chain folgen (BFS, start + type + depth) |
| `tim_health` | DB-Integritäts-Check (Broken Links, Orphans, FTS) |
| `tim_stats` | Memory-Statistiken (totals, depth, tags, confidence) |
| `tim_doctor` | Comprehensive Diagnostics (Config, DB, API) |
| `tim_load_project` | Project by Label/Alias laden + Session binden |
| `tim_read_project` | Project lesen OHNE Session-Binding (Cross-Project) |
| `tim_show` | Unified Overview: tasks, errors, bugs, ideas, decisions, commits |
| `tim_show_unsummarized` | Nächsten unsummarized Batch einer Session zurückgeben |
| `tim_show_all_unsummarized` | Alle unsummarized Batches aller Sessions scannen |
| `tim_show_untagged` | Batch-Summary-Nodes ohne Content-Hashtags |
| `tim_error_stats` | Error-Statistiken (totals, rate, alerts) |

### Write/Update-Tools

| Tool | Beschreibung |
|------|-------------|
| `tim_write` | Entry schreiben (parentId oder parentTitle+projectId) |
| `tim_update` | Entry aktualisieren (nur geänderte Felder) |
| `tim_link` | Edge zwischen zwei Entries erstellen |
| `tim_rename_title` | Titel eines Entries umbenennen |
| `tim_delete` | Entry löschen (soft: irrelevant, hard: tombstone) |
| `tim_update_many` | Batch-Update (flags only: irrelevant, favorite) |
| `tim_rename_entry` | Entry-ID atomar umbenennen + References updaten |
| `tim_move_entry` | Entry unter neuen Parent verschieben + Depth-Cascade |
| `tim_write_batch_summary` | Idempotentes Batch-Summary schreiben |
| `tim_rollup_session_summary` | Batch-Summaries in Session-Summary-Root folden |
| `tim_tag_add` | Tags hinzufügen (dedupliziert) |
| `tim_tag_remove` | Tags entfernen |
| `tim_tag_rename` | Tag über alle Entries umbenennen |

### Session/Admin-Tools

| Tool | Beschreibung |
|------|-------------|
| `tim_session_start` | Session starten (idempotent) |
| `tim_session_log` | Exchange an Session anhängen |
| `tim_record_commit` | Git-Commit unter Project/Commits eintragen |
| `tim_checkpoint` | Session-Checkpoint + verify-before-decay |
| `tim_create_project` | Project registrieren (für load_project) |
| `tim_lease` | Temporären Agenten-Zugriff grant/revoke |
| `tim_suppress` | Pattern zu Negative Memory hinzufügen |
| `tim_export` | DB als .tim/.md exportieren |
| `tim_import` | .hmem-Datei importieren |
| `tim_sync` | Sync: push/pull/status |
| `tim_error_log` | Error-Eintrag loggen |

> **Note (R12):** Alle Tools sind implementiert in `~/projects/tim/packages/tim-mcp/src/server.ts`.
> Siehe dort für die genauen Input/Output-Schemas (Zod-Schemas in `server.ts`).

> **Note (Review):** Zwei Tools/Konzepte tauchen nur in der Liste auf, ohne im Fließtext
> erklärt zu sein: `tim_suppress` („Negative Memory"/Suppress-Pattern) und `tim_lease`
> (Agenten-Leasing). Beide sind in `TIM.md` nicht vorgesehen — kurzen Abschnitt ergänzen,
> was „Negative Memory" ist und wie Leasing zum Visibility-Modell (§3) passt.

> **Note (Review):** `tim_load_project` ist der heißeste Pfad fürs Kontext-Sparen (Bennis
> Kernziel), kann aber bei großen Projekten selbst riesig werden. Es fehlt eine
> Budget-/Truncation-Strategie (z. B. nur Summaries + Next Steps + offene Tasks, Rest
> per Lazy-Load). Ohne das frisst `load_project` genau das Kontextfenster, das TIM
> schonen soll.

---

## 14. Skills — 15 Published Skills

### TIM-Kern-Skills (10)

| Skill | Trigger | Zweck |
|-------|---------|-------|
| **tim-read** | "was war der letzte Stand", "continue where we left off" | Project laden, Memory lesen |
| **tim-write** | Entry-Erstellung | Entry schreiben mit Prefix/Tree/Tags-Auswahl |
| **tim-search** | Unbekannte Referenzen | FTS5-Suche + Recall |
| **tim-recall** | Tiefe Suche | Sub-Agent Dispatch for Memory Search |
| **tim-load-project** | Project-Referenz | tim_load_project vs tim_read_project |
| **tim-using** | Meta | Wann welches Tool + Habits |
| **tim-curate** | "aufräumen", "clean up memory" | Curate: irrelevant, fix titles, consolidate |
| **tim-new-project** | "register a new project" | Project + Schema + Sections |
| **tim-new-task** | "new task" | Task unter Project/Tasks |
| **tim-new-error** | Bug gefunden | Error mit Sub-Nodes + Schema |

### Meta-Skills (5)

| Skill | Trigger | Zweck |
|-------|---------|-------|
| **tim-config** | Config-Änderung | Config lesen/schreiben/validieren |
| **tim-update** | "update tim" | TIM aktualisieren (npm update) |
| **tim-release** | Release-Vorbereitung | Pre-Publish Checklist |
| **tim-handoff** | `/tim-handoff` | Session beenden + Summarizer + Marker schreiben |
| **tim-usage** | "usage check" | Subscription/Balance-Check für TIM |

> **Note (R13):** 10 Kern-Skills + 5 Meta-Skills = 15 published. Plus 1-2
> Dev-Skills (gitignored). Skills liegen in `~/.hermes/profiles/worker/skills/tim-*/`.
> `tim-config`, `tim-update`, `tim-release`, `tim-handoff`, `tim-usage` sind
> teilweise noch geplant (Phase 0.7+).

> **Note (Review):** Im ursprünglichen Paper standen 16/11 — die Kern-Tabelle
> listet aber nur 10 Skills. Vor dem Abnicken gegen den tatsächlichen Inhalt von
> `~/.hermes/profiles/worker/skills/tim-*/` prüfen: Fehlt ein Kern-Skill (z. B.
> `tim-suppress`/`tim-curate`-Variante), oder war die 11 schlicht falsch gezählt?

---

## 15. Roadmap — 0.6 → 1.0

### Phase 0.6: Final Spec + Paper (AKTUELL)

**Acceptance Criteria:**
- [x] TIM Vision-Paper v2.0 geschrieben (dieses Dokument)
- [ ] Paper von Benni reviewed und als "Mein Soll-Zustand" abgenickt
- [ ] Code-Bestandsaufnahme: was fehlt noch zum Paper?

### Phase 0.7: Embeddings + Sharing (Next)

**Acceptance Criteria:**
- [ ] Embedding-Provider (lokal + API) implementiert
- [ ] Embedding-Similarity (Schicht 3) on-demand
- [ ] Schicht-2+3 in `tim_search` hybrid integriert
- [ ] Session-Nodes als Root-Nodes (Breaking Change R7)
- [ ] `.tim-project` Discovery auf CWD-only (Breaking Change R9)
- [ ] `tim-migrate` Rewrite (R18)
- [ ] o9k-Skills → TIM-Skills Übergang starten (R19)
- [ ] `tim-config`, `tim-update`, `tim-release` Skills geschrieben

### Phase 0.8: Sync-Public Beta

**Acceptance Criteria:**
- [ ] Sync-Server läuft auf Strato VPS
- [ ] E2E-Encryption (AES-256-GCM + scrypt)
- [ ] Passphrase-Rotation + Revocation (R10)
- [ ] Owner-Notification bei Konflikten (R11)
- [ ] Auto-Sync bei Session-Ende
- [ ] `tim-sync-client` Package fertig
- [ ] Sync-Tests: 200+ (portiert aus hmem v2 Branch)

### Phase 0.9: Doku + Onboarding + E2E-Tests

**Acceptance Criteria:**
- [ ] README mit Quick-Start (3 Schritte: install → init → use)
- [ ] CLI Reference vollständig
- [ ] MCP Tool Reference vollständig (dieses Paper + server.ts)
- [ ] Skill-Doku (jeder Skill hat SKILL.md + Beispiel)
- [ ] E2E-Tests: Session-Start → Exchange → Batch → Summary → Rollup
- [ ] E2E-Tests: Sync Push → Pull → Reconcile
- [ ] E2E-Tests: hmem → TIM Migration (Dry-Run + Real)
- [ ] 200+ Tests insgesamt

### Phase 1.0: Public Release

**Acceptance Criteria:**
- [ ] npm publish (`tim-mcp`, `tim-cli`, `tim-core`)
- [ ] GitHub Release mit Release Notes
- [ ] Docs: Getting Started + Architecture + API + Examples
- [ ] Brew/apt-get Alternative (optional)
- [ ] Ankündigung: HN, Reddit, Twitter

> **Note (R17):** 5 Phasen, keine 3.0 als Endziel. Phase 0.6 ist aktuell
> (dieses Paper ist der Output). Phasen 0.7-1.0 sind grob geschätzt,
> Zeiten können variieren.

---

## 16. hmem-Migration — `tim-migrate` überarbeiten

**hmem (its-over-9k)** war der Vorgänger von TIM. Der aktuelle `tim-migrate`
muss **komplett überarbeitet werden** (eigener Task in P0063).

### Mapping

| hmem | TIM |
|------|-----|
| Entry ID (P0001) | Entry ID (E0001), metadata: {hmem_id: P0001} |
| Prefix (P/L/E/T/D/M) | metadata.type |
| 5-Level-Hierarchie | parent_id + depth |
| Links (string[]) | Edges (type=relates) |
| Tags (#sql) | Edges (type=tagged) |
| O-Entries (Session-Log) | Session-Nodes (Edges: type=session_exchange) |
| Sync (hmem-sync) | `tim sync` (kompatibles Protokoll für Transition) |

> **Note (Review):** Die Mapping-Zeile „`P0001` → `E0001`" widerspricht §3: dort hat
> jeder Type seinen eigenen Prefix (project=`P`, task=`T`, …). Wenn bei der Migration
> *alles* zu `E####` wird und der echte Type nur ins Metadata wandert, verlieren die
> Kurz-IDs ihre menschenlesbare Type-Erkennbarkeit (gerade das Feature aus `TIM.md`
> „Alternative ID, bei der man direkt den Typ sieht"). Vermutlich gemeint: *Entry-ID*
> generisch, **Prefix bleibt typ-spezifisch** (`P0001`→`P0001`, hmem-Original in
> `metadata.hmem_id`). Zeile entsprechend korrigieren.

| hmem (alt) | TIM (neu) |
|------------|-----------|
| relates | relates |
| extends | extends |
| implements | implements |
| blocks | blocks |
| contradicts | contradicts |
| tagged | → Tags |
| summarizes | → Tags |
| leases | leases (optional) |
| session_exchange | → Edges + Session-Nodes |

### Migration-Befehl

```bash
tim migrate --from ~/.hmem/personal.hmem --to ~/.tim/tim.db
```

> **Note (R18):** Der aktuelle `tim-migrate` in `packages/tim-migrate/` ist
> unvollständig. Rewrite ist ein eigener Task. Alte hmem-DB bleibt als Backup.
> Siehe P0063/Tasks für den genauen Stand.

---

## 17. o9k-Abgrenzung — Framework vs. Memory

**o9k (its-over-9k)** ist das **Framework** (Skills, Cron, Orchestrierung).
**TIM** ist das **Memory** (Datenbank, Sync, Embedding).

### Prinzip

```
o9k = Framework  │  TIM = Memory
─────────────────┼────────────────
Skills (o9k-*)   │  Skills (tim-*)
Cronjobs          │  Store (SQLite)
Orchestrierung    │  Sync
Session-Management│  Embeddings
                  │  Search
```

### Parallel-Setup

Beide Skill-Familien existieren parallel:
- `o9k-*` = Framework-Skills (orchestrieren, delegieren, managen)
- `tim-*` = Memory-Skills (lesen, schreiben, suchen, curaten)

**Memory-Interface:** Default ist hmem (für Abwärtskompatibilität).
Per Config-Switch (`config.memory_interface: "tim"`) auf TIM umstellen.

### Skill-Überschneidungen

| o9k-Skill | TIM-Äquivalent | Status |
|-----------|----------------|--------|
| o9k-read | tim-read | Parallel |
| o9k-write | tim-write | Parallel |
| o9k-search | tim-search | Parallel |
| o9k-new-project | tim-new-project | TIM neuer |
| o9k-new-error | tim-new-error | TIM neuer |
| o9k-curate | tim-curate | TIM neuer |
| o9k-recall | tim-recall | TIM neuer |

> **Note (R19):** o9k-Skills bleiben parallel als `o9k-*`. TIM hat `tim-*`.
> Klare Trennung. o9k-Skills referenzieren `o9k-memory-interface` Paket,
> das austauschbar ist.

---

## 18. YAML-Schema-Beispiele

### Project

```yaml
# schemas/project.yaml
type: project
kind: project
label: P0063
title: "TIM — Theoretically Infinite Memory"
tags:
  - project
  - memory
  - mcp
  - agent
  - planning
metadata:
  status: active
  created_at: "2026-05-29"
  packages: 10
  tests: 101
tree_template:
  sections:
    - Overview: {}
    - Rules:
        children: [Agent Rules, Git Rules, Style Rules]
    - Log: { render_tail: true }
    - Decisions: {}
    - Codebase: {}
      - Modules: {}
        - Functions: {}
      - Pipeline: {}
    - Usage: {}
    - Bugs: {}
    - Roadmap: {}
    - Ideas: {}
    - Tasks:
        task_root: true
    - Sessions:
        kind: sessions-root
        render_depth: 0
        order: 1000
    - Commits:
        render_tail: true
```

### Task

```yaml
# schemas/task.yaml
type: task
kind: task
parent_title: Tasks     # Wird unter Project/Tasks einsortiert
title: "Implement Embedding Provider"
tags:
  - task
  - phase-0.7
  - embedding
metadata:
  task:
    status: todo        # todo | in_progress | done | cancelled
    priority: high      # high | medium | low
    due: "2026-07-15"
    estimate: medium    # small | medium | large
  phase: 0.7
body: |
  ## Background
  TIM needs embedding support for semantic search (Schicht 3).
  
  ## Scope
  - EmbeddingProvider Interface
  - Local provider (all-MiniLM-L6-v2 via onnx)
  - API provider (OpenAI, local LLM)
  - Hybrid search (FTS5 + Embedding weighted)
  
  ## Steps
  1. Define EmbeddingProvider interface in tim-core
  2. Implement local ONNX provider
  3. Implement OpenAI API provider
  4. Add hybrid search to tim-search
  5. Tests for both providers + hybrid search
```

### Session

```yaml
# schemas/session.yaml
type: session
kind: session
title: "2026-06-17-1123"
tags:
  - session
metadata:
  session:
    session_id: "01JX..."
    project_ref: "P0063"
    agent: "deepseek-v4-flash"
    harness: "hermes"
    date: "2026-06-17T11:23:00Z"
    batch_size: 5
    summarizer:
      cli: claude
      model: haiku
    exchange_count: 14
    batches_summarized: 2
children:
  - Summary:
      kind: session-summary-root
      tags: [session-summary]
      metadata:
        exchanges: 14
        date: "2026-06-17"
        summary: "Finalized vision paper. Implemented 3-layer graph."
      children:
        - Batch 1:
            kind: batch-summary
            metadata:
              batch_index: 1
              seq_from: 1
              seq_to: 5
  - Exchanges:
      kind: exchanges-root
      render_depth: 0
      children: []  # Raw exchanges, not rendered by default
```

### Rule

```yaml
# schemas/rule.yaml
type: rule
kind: rule
parent_title: Rules/Agent Rules
title: "Kein direktes SQL auf tim.db"
tags:
  - rule
  - critical
  - database
metadata:
  rule:
    applies_to: [all_agents]
    severity: critical
body: |
  NIEMALS direktes SQL auf ~/.tim/tim.db ausführen — kein sqlite3,
  kein terminal mit SQL-Queries. Nur TIM MCP Tools (tim_read, tim_search,
  tim_write, tim_update, tim_update_many, tim_load_project, tim_read_project)
  für jeglichen DB-Zugriff.
  
  Grund: Raw SQL bypassed WAL journaling, integrity checks, and tree-structure
  logic — risk of corruption.
```

### User

```yaml
# schemas/user.yaml
type: user
kind: user
title: "bbbee"
tags:
  - user
  - admin
metadata:
  user:
    role: owner
    preferred_language: de
    preferred_model: deepseek-v4-flash
    communication_style: concise
    aliases:
      - Benni
      - Bumblebiber
    skills_active:
      - tim-read
      - tim-write
      - cli-tools
```

---

## 19. History-Notes

Alle 19 Design-Entscheidungen aus dem grill-me (2026-06-17) mit Begründung und
Konsequenz.

### R1 — Ziel des Papers

**Decision:** Eigenständiges Vision-Paper, das `tim-design.md` ersetzt/ergänzt.
Code-Stand wird zitiert, ist aber nicht Source of Truth.

**Warum:** Benni wartet auf ein kompetenteres KI-Modell, das entweder den
bestehenden Code fertig schreibt oder alles neu schreibt. Das Paper ist
Briefing-Material für diese zukünftige KI.

**Konsequenz:** Paper muss kontextfrei und vollständig sein. Siehe §1.

### R2 — Storage-Backend

**Decision:** SQLite + FTS5 bleibt. Scaling durch Projekt-Sharding und
Cold-Node-Komprimierung.

**Warum:** Lokal, kein Server-Setup, FTS5 für Volltextsuche, WAL-Mode für
concurrent reads.

**Konsequenz:** Keine DB-Abstraktion nötig im v2. `better-sqlite3` im Code.
Siehe §3 (Entry-Struktur).

### R3 — "Neuronales Netz" zwischen Nodes

**Decision:** Drei-Schichten-Graph: (1) explizite Edges, (2) Tag-TF-IDF-Similarity
on-read, (3) Embedding-Similarity on-demand/lokal.

**Warum:** Genau Bennis "Neuronales Netz"-Metapher. Schicht 3 ist optional/Pro,
hält Writes billig.

**Konsequenz:** Embedding-Provider in der Config. Siehe §5.

### R4 — Edge-Types auf Minimal-Set reduziert

**Decision:** Nur 5 Types: `relates`, `extends`, `implements`, `blocks`,
`contradicts`. Alles andere per Tags.

**Warum:** Konsistenz. Tags sind ohnehin User-Filter. 5 Types reichen für
95% der Use-Cases.

**Konsequenz:** Schema-Migration nötig — alte 9er→5er. `tim-migrate` mapped.
Siehe §4.

### R5 — Node-Types: 11 Types, konfigurierbar

**Decision:** 11 Types, NICHT hard-coded. In der Config definiert, beliebig
erweiterbar.

**Warum:** Konsistenz mit hmem/o9k-Vergangenheit, aber Flexibilität für
Custom-Types.

**Konsequenz:** Config hat `node_types: [list]`. Siehe §3.

### R6 — Schemas als Type + Tree-Template

**Decision:** Schemas = Type + Tree-Template (welche Sub-Node-Types auto-erzeugt).
Nicht jeder Type hat ein Schema, aber jedes Schema hat einen Type.

**Warum:** Generator-Ansatz: `tim_new(type="project")` erzeugt gesamten Sub-Tree.

**Konsequenz:** Schemas liegen in `schemas/<type>.yaml`. Siehe §6.

### R7 — Session-Nodes als Root-Nodes (Breaking Change)

**Decision:** Sessions sind eigenständige Root-Nodes, verlinken per `implements`
/ `relates` zu Projekten. **Breaking Change** zum aktuellen Code.

**Warum:** Sessions können mehrere Projekte berühren, eigener Lifecycle,
Project-Subtree bleibt sauber.

**Konsequenz:** Migration geplant für Phase 0.7. Siehe §7.

### R8 — Summarizer-Trigger: Per-Batch + Manuell

**Decision:** Per-Batch-Trigger UND manueller Trigger via `/tim-handoff`.
`show_unsummarized` Backfill ist bounded (aktuelle Session).

**Warum:** Bounded, kein Block-Risiko beim Session-Start.

**Konsequenz:** Summarizer läuft async nach Batch-voll. Siehe §8.

### R9 — `.tim-project` Discovery: KEIN Walk

**Decision:** KEIN Walk-up. Nur CWD. Sub-Dirs brauchen explizites
`tim project use <name>`.

**Warum:** Streng, null Magie. Verhindert falsche Projekt-Erkennung.

**Konsequenz:** `tim project browse` listet Projekte. Breaking Change geplant.
Siehe §9.

### R10 — Sync-Sharing-Revocation via Passphrase-Rotation

**Decision:** Passphrase-Rotation + Auto-Invalidate. Owner rotiert, Server kennt
nur neue Versionsnummer, Clients mit alter Version erkennen Diskrepanz.

**Warum:** E2E-Verschlüsselung bleibt erhalten. Server sieht nur Versionsnummern.

**Konsequenz:** Sync-Protocol-Version in Config. Revocation in `tim-sync`.
Siehe §10.

### R11 — Sync-Konflikte: Owner-Notification

**Decision:** Owner-Notification + Owner-Entscheidung. "Dein Write oder seins
oder merge?"

**Warum:** Im seltenen Konfliktfall will Benni manuelle Kontrolle.

**Konsequenz:** Sync-Server broadcastet Conflict-Notification. Siehe §10.

### R12 — Tools: Alle 37 Einzeln Dokumentiert

**Decision:** Alle 37 MCP-Tools einzeln mit Mini-Beschreibung. Paper wird
Tool-Reference.

**Warum:** Vollständigkeit wichtiger als Kürze.

**Konsequenz:** Lange Sektion §13, gruppiert nach Phase (Read/Write/Admin/Session).

### R13 — Skills: 15 Published + 1-2 Dev

**Decision:** 15 published Skills (10 tim-* + 5 Meta: tim-config, tim-update,
tim-release, tim-handoff, tim-usage). Plus 1-2 Dev-Skills (gitignored).

**Warum:** Klar abgegrenzte Skill-Familie.

**Konsequenz:** Skill-Liste in §14 mit Trigger + Zweck.

### R14 — Architektur: 10 Packages

**Decision:** 10 Pakete wie aktuell. Keine Änderung.

**Warum:** Im Code schon etabliert, klare Trennung.

**Konsequenz:** Architektur-Sektion §2 zeigt Paket-Verantwortlichkeiten.

### R15 — Config: 13 Keys, Selbsterklärend

**Decision:** Alle 13 Keys mit Beschreibung + Default + "wann ändern"-Hinweis.

**Warum:** Benni fordert selbsterklärende Config.

**Konsequenz:** YAML-Block mit allen Keys in §11.

### R16 — Statusline: Opt-in, Privacy-First

**Decision:** Opt-in pro Feld. Default: Project + Batch-Counter. Kontextlevel
erfordert explizite Bestätigung.

**Warum:** Privacy-respektierend.

**Konsequenz:** `statusline` Sub-Config mit Boolean-Flags. Siehe §12.

### R17 — Roadmap: 5 Phasen 0.6 → 1.0

**Decision:** 5 Phasen: 0.6 (Final Spec) → 0.7 (Embeddings) → 0.8 (Sync) →
0.9 (Doku + Tests) → 1.0 (Public Release).

**Warum:** Pre-Release, klare Phasen. Kein 3.0 als Endziel.

**Konsequenz:** Roadmap-Sektion §15 mit Akzeptanzkriterien pro Phase.

### R18 — hmem-Migration: `tim-migrate` überarbeiten

**Decision:** `tim-migrate` macht hmem→TIM. Edge-Types gemappt (9→5).
Alte hmem-DB bleibt als Backup. **tim-migrate muss nochmal komplett überarbeitet
werden** (eigener Task).

**Warum:** hmem-Nutzer sollen migrieren können. Kein Datenverlust.

**Konsequenz:** Eigener Task in P0063. Siehe §16.

### R19 — o9k-Abgrenzung: Framework vs. Memory

**Decision:** o9k-Skills bleiben parallel als `o9k-*` (Framework), TIM hat
`tim-*` (Memory). Memory-Interface per Default hmem, per Config-Switch auf TIM.

**Warum:** o9k ist Framework, TIM ist Memory. Klare Trennung.

**Konsequenz:** o9k-Skills referenzieren `o9k-memory-interface` Paket.
Siehe §17.

---

## Referenzen

- **Codebase:** `~/projects/tim/` — der aktuelle Code
- **TIM Design (alt):** `~/projects/tim/docs/tim-design.md` — Architektur v1.0
- **Session System Plan:** `~/projects/tim/docs/session-system-plan.md` — Session-Architektur
- **Start Hook Plan:** `~/projects/tim/docs/start-hook-plan.md` — Session-Start-Hooks
- **Project Schema:** `~/projects/tim/docs/project-schema.json` — Schema-Spezifikation
- **P0063 in TIM:** Aktives TIM-Project — Log, Tasks, Ideas, Decisions
- **hmem (Vorgänger):** `~/projects/hmem/` — its-over-9k, für Abgrenzung
- **Skills:** `~/.hermes/profiles/worker/skills/tim-*/` — 10 TIM-Skills
- **Config:** `~/.tim/config.json` — Live-Config
- **DB:** `~/.tim/tim.db` — Live-Datenbank
