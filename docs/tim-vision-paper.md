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
> abweichen, steht im Fließtext als Design-Weiche markiert.

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

TIM (Theoretically Infinite Memory) = **local-first, selbst-optimierendes Gedächtnissystem
für KI-Agenten**. Kernproblem aller AI-Coding-Agents: nach 10 Minuten Konversation
Kontext des letzten Monats weg.

**Vision:** Agent erinnert sich — nicht nur letzte 5 Messages, sondern Entscheidungen
letzte Woche, Bugs letzten Monat, Architektur-Prinzipien vom Projektstart. User
wiederholt nichts.

**Wichtigste Eigenschaften:**
- **Local-first:** Ein Befehl (`tim init`), eine Datei (`~/.tim/tim.db`). Kein Server Pflicht.
- **Weighted Hypergraph:** Nicht nur Baum (hmem 5-Level), sondern typisierte Edges zwischen
  beliebigen Nodes. `contradicts`, `implements`, `blocks`.
- **Selbst-optimierend:** Cold-Node-Kompression hält DB schlank — abgeleitetes Wissen
  komprimiert/ausgelagert; Roh-Exchanges bleiben erhalten.
- **Sync:** E2E-verschlüsselt über TIM-Sync-Server. Passphrase-Rotation + Per-Node-Keys
  für Revocation.
- **Agenten-unabhängig:** MCP-Standard. Jeder Agent (Claude Code, Cursor, Hermes,
  OpenCode, Codex) spricht MCP.

hmem (its-over-9k) = Vorgänger. 5439-Zeilen-Store-Monolith, keine typisierten Edges,
kein Embedding-Support. TIM = Greenfield-Rewrite mit 10 Packages, 101+ Tests.
Siehe [§16 hmem-Migration](#16-hmem-migration--tim-migrate-überarbeiten).

**„Theoretically Infinite" vs. Kompression:** Kein Widerspruch wenn Schichten klar getrennt.
**Abgeleitetes Wissen** (Summaries, Lessons, Confidence-Scores) darf komprimiert werden —
Cold-Node-Kompression (R2), nicht Löschung. **Roh-Exchanges** werden **nie gelöscht**,
nur kalt-komprimiert/ausgelagert wenn Zugriff selten. `TIM.md` verspricht „Konversationen
im **Originalton**" — das gilt für Exchanges. Summaries sind abgeleitet, ersetzen nicht
Original. Skalierungsproblem = unbegrenzt wachsende Exchange-Rohdaten → Cold-Node +
Sharding (R2), nicht automatisches Vergessen.

---

## 2. Architektur (10 Packages)

TIM = Monorepo, 10 npm-Workspaces (`packages/`). Jedes Package eine Verantwortung.
Package-Interface version-locked. Abhängigkeiten gerichtet.

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
└───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └───┘ └────┘
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

10er-Paket-Struktur im Code etabliert (R14). Siehe `~/projects/tim/packages/` für Ist-Stand.
`tim-sync-client` und `tim-skills` teilweise noch geplant (Phase 0.7).

### Package-Design-Prinzipien

Jedes Package exportiert nur über `@tim/<name>` Public API. Interne Module bleiben
intern — keine Cross-Package-Imports außerhalb Dependency-Graph. Version-Lock via
Workspace-Protocol (`"tim-core": "workspace:*"`). Breaking Changes in tim-core
propagieren semver-bump über alle Packages.

**tim-store** = einziger SQLite-Touchpoint. Kein anderes Package öffnet `tim.db` direkt.
Alle Writes durch Store-Layer → WAL, FTS-Trigger, Staging-Ledger konsistent.

**tim-mcp** = dünne Schicht über Store + Search. Tool-Handler delegieren, enthalten
keine Business-Logic die Store umgeht.

**tim-summarizer** = separater Prozess/CLI. Liest Exchanges, schreibt Batch-Summaries
via MCP oder direkt Store (mit busy_timeout). Siehe §8 Concurrency.

---

## 3. Nodes — 11 Types + Erweiterbarkeit

TIM hat **11 built-in Node-Types**, Liste **nicht hard-coded**. Config definiert
(`node_types: [list]`), beliebig erweiterbar.

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

Konsistenz mit hmem/o9k-Vergangenheit, Flexibilität für Custom-Types (R5). Config
`node_types: [project, task, session, ...]` erweiterbar. Jeder Type optional via
Schema validiert.

### Entry-Struktur (SQLite-API)

Jeder Node = Entry in `entries`-Tabelle:

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `id` | TEXT (ULID) | Primärschlüssel, global eindeutig |
| `parent_id` | TEXT | Elternknoten (NULL = Root) |
| `title` | TEXT | Kurztitel (Listing, Navigation) |
| `content` | TEXT | Volltext-Body |
| `summary` | TEXT | Lazy-Load-Kurzfassung (Node + direkte Children) |
| `content_type` | TEXT | `text`, `json`, `blob` |
| `depth` | INTEGER 1-5 | Hierarchie-Tiefe im Baum |
| `confidence` | REAL 0.0-1.0 | Vertrauenswert für abgeleitetes Wissen |
| `created_at` | TEXT (ISO 8601) | Erstellzeit |
| `updated_at` | TEXT (ISO 8601) | Letzte inhaltliche Änderung (LWW-Sync) |
| `accessed_at` | TEXT (ISO 8601) | Letzter Lesezugriff (Cold-Node-Hint) |
| `visibility` | INTEGER (Bitmask) | Owner (1), Trusted (2), Leased (4), Public (8) |
| `tags` | JSON-Array | Topic-Tags |
| `irrelevant` | INTEGER | Soft-Delete (Curator/Agent markiert) |
| `tombstoned_at` | TEXT | Hard-Delete-Marker (Sync-Tombstone) |
| `metadata` | JSON | Typ-spezifisch — siehe unten |

**metadata JSON-Felder (Standard-Keys):**

| Key | Typ | Zweck |
|-----|-----|-------|
| `kind` | string | Sub-Typ (section, exchange, batch-summary, …) |
| `status` | string | task/bug/project Status |
| `priority` | string | high/medium/low |
| `role` | string | exchange role (user/agent) |
| `seq` | number | Exchange-Sequenz |
| `origin_device` | string | Gerät das Entry erstellt (Sync-Debug, nicht in ULID) |
| `lease_holder` | string | Agent-ID mit temporärem Leased-Zugriff |
| `lease_expiry` | string (ISO) | Ablauf Leased-Zugriff |
| `lease_scope` | string | read/write Scope des Leases |
| `label` | string | Kurz-ID menschenlesbar (z.B. `P0063`) — **nicht** PK |

**Nach der Tabelle — Design-Entscheidungen:**

- **`summary` lazy-load:** `tim_read` liefert standardmäßig `title` + `summary` + Children-
  Titles/Summaries. Voller `content`-Body nur mit Flag `include_body=true`. Spart Kontext
  gegen OKF-Ansatz (nur Summaries in Prompt, Bodies on-demand). Summaries werden bei Write/
  Update/Summarizer-Rollup gepflegt — nicht bei jedem Read berechnet.

- **`updated_at` für LWW:** Last-Write-Wins bei Sync-Konflikten. `created_at` immutable.
  `accessed_at` nur Lesesignal, zählt nicht für Merge. Store setzt `updated_at` bei jedem
  inhaltlichen Update automatisch.

- **ULID = PK, Kurz-ID in metadata:** `id` = ULID (zeitlich sortierbar, kollisionsfrei
  multi-device). Menschenlesbare Labels (`P0063`, `T0042`) leben in `metadata.label` —
  pro-Type-Counter, beim Sync gemappt (Kollision → Remap + Edge `relates` alt→neu).
  ULID enthält **kein** Gerät — `origin_device` separat in metadata wenn Sync-Debug nötig.

- **`depth` 1-5 nur Baum:** Baum-Hierarchie capped bei 5 (hmem-Kompatibilität, Listing-
  Performance). **Hypergraph tiefer:** Beliebige semantische Tiefe über Edges (`implements`,
  `extends`, …). Tiefe 6+ Beziehungen = Edge-Chains, nicht Parent-Child. `tim_trace` folgt
  Edges unbegrenzt (Budget-Parameter).

### Visibility + Leasing (Node-Metadata, kein Edge-Type)

Visibility-Bitmask steuert wer Node sieht. Leasing = temporärer Agent-Zugriff via
`metadata.lease_holder`, `lease_expiry`, `lease_scope` — **nicht** als Edge-Type.
`tim_lease` setzt/cleart diese Metadata-Felder + passt Visibility-Bit Leased (4) an.
Nach Expiry: Lease-Felder cleared, Visibility zurück auf Owner-default.

---

## 4. Edges — 5-Types Minimal-Set

TIM = **Minimal-Set 5 Edge-Types**. Rest per Tags.

| Edge-Type | Bedeutung | Beispiel |
|-----------|-----------|----------|
| **relates** | Allgemeine Beziehung | Session ↔ Project |
| **extends** | Erweiterung/Verfeinerung | Bug ↔ Fix-Commit |
| **implements** | Implementierung | Commit implementiert Task |
| **blocks** | Blockade | Bug blockiert Release |
| **contradicts** | Widerspruch | Zwei widersprüchliche Entscheidungen |

Ursprünglich 9 Types geplant (R4). Reduziert — Tags = User-Filter, 5 Types reichen
95% Use-Cases. `tim-migrate` mapped 9er→5er.

**Leases = kein Edge-Type.** Leasing läuft über Node-Metadata (§3). 5er-Set bleibt
konsistent — kein sechster Type `leases`.

### Edge-Struktur

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `id` | TEXT (ULID) | Eindeutige ID |
| `source_id` | TEXT | Startknoten |
| `target_id` | TEXT | Zielknoten |
| `type` | TEXT | Einer der 5 Types |
| `weight` | REAL 0.0-1.0 | Gewichtung (optional) |
| `metadata` | JSON | Zusatzfelder (Anmerkung, Kontext — **kein** lease_expiry) |

### Orphan-Edge-Handling

Node soft-delete (`irrelevant=1`) oder hard-delete (`tombstoned_at` gesetzt) →
verknüpfte Edges behandeln:

1. **FK CASCADE** auf `source_id`/`target_id` wo möglich (Edge gelöscht mit Node)
2. **`tim_trace` / Graph-Traversal:** Filtert Edges deren Endpunkt tombstoned/irrelevant
3. **`tim_health`:** Reportet verwaiste Edges (Endpunkt fehlt) zur manuellen Curate

Kein automatisches „Verfallen" von Edges — nur explizite Löschung/Kaskade.

---

## 5. Connections — Drei-Schichten-Graph

Bennis „Neuronales Netz"-Metapher = drei Schichten:

### Schicht 1: Explizite Edges (immer aktiv)

Typisierte Beziehungen (§4). Explizit per `tim_link`. Sofort sichtbar, keine Berechnung.

### Schicht 2: Tag-TF-IDF-Similarity (on-read, immer aktiv)

Beim Lesen: ähnliche Nodes via Tag-Overlap. `tim_read(id="P0063")` zeigt neben Children
auch „Related by Tags".

```
# Jeder Tag t: IDF-Gewicht w(t) = log(N / df(t))
#   N      = Gesamtzahl Nodes
#   df(t)  = Anzahl Nodes mit Tag t
# → seltene Tags wiegen mehr (TIM.md Rare-Tag-Gewichtung)

                   Σ_{t ∈ tags(A) ∩ tags(B)} w(t)²
Similarity(A, B) = ─────────────────────────────────────────────
                   sqrt(Σ_{t ∈ A} w(t)²) · sqrt(Σ_{t ∈ B} w(t)²)
```

Cosine über IDF-gewichtete Tag-Vektoren — nicht reines Set-Overlap.

#### Tag-Frequency — inkrementelle df-Pflege

`df(t)` bei jedem Read neu zu zählen = O(N) — untragbar. Lösung: **`tag_frequency`-Tabelle**
(incremental maintenance):

| Spalte | Typ | Beschreibung |
|--------|-----|-------------|
| `tag` | TEXT PK | Tag-Name |
| `df` | INTEGER | Document Frequency (Node-Count mit Tag) |
| `updated_at` | TEXT | Letzte Rekalibrierung |

**Write-Pfad:** `tim_write` / `tim_update` / `tim_tag_add` / `tim_tag_remove` →
Store diff't alte vs. neue Tags → `df` +/- 1 pro betroffenem Tag. Atomar in derselben
Transaction wie Entry-Update.

**Read-Pfad:** `N` = `SELECT COUNT(*) FROM entries WHERE irrelevant=0 AND tombstoned_at IS NULL`.
`w(t) = log(N / max(df(t), 1))`. On-read Similarity = O(|tags(A)| + |tags(B)|).

**Reconcile-Job** (optional, `tim doctor`): Vollscan verifiziert df gegen Ground-Truth,
korrigiert Drift nach Crash. Läuft selten — nicht im Hot-Path.

### Embedding-Provider-Privacy

Config `embedding_provider.type: api` schickt Node-Inhalte an externen Dienst (OpenAI etc.).
Bei E2E-verschlüsselter DB = Datenabfluss-Pfad. **Default für sensible Setups:**
`type: local` (ONNX, z.B. all-MiniLM-L6-v2). API-Provider explizit opt-in, Config-Kommentar
welche Werte lokal vs. Cloud. Hybrid-Search (Schicht 3) nur wenn Provider gesetzt —
Schicht 1+2 brauchen keinen externen Call.

### Schicht 3: Embedding-Similarity (on-demand / Pro-Feature)

Optional: Embedding-Provider (lokal ONNX oder API) erzeugt Vektoren pro Node.
`tim_search(query="...", searchType="hybrid")` nutzt cosine-similarity + FTS5-Gewichtung.
Phase 0.7 (R3). Writes billig — Embeddings lazy/on-demand, nicht bei jedem `tim_write`.

### Schicht 4: Hook-Filter — Noise-Abwehr vor der DB (2026-06-22)

Der `o9k-log-exchange.sh` Hook (Write-Pfad von Hermes → TIM) filtert
**systemgenerierte Noise** bevor sie als Exchange in die DB gelangen.
Lektion aus 468 Riesen-Einträgen (Skill-Injektionen, Plugin-Cache-Dumps)
die ~9 MB DB-Speicher verschwendeten.

**7 Guard-Muster** (in Reihenfolge, früher Exit = Skip):

| # | Muster | Quelle | Was es fängt |
|---|---|---|---|
| 1 | `cron_*` Session-ID | Cron-Bug (2026-06-22) | Alle Cron-Ticks (48 Einträge) |
| 2 | `[IMPORTANT: user invoked "X" skill]` | Skill-Assembly | Skill-Injektionen mit Prefix |
| 3 | `Base directory for this skill:` | Claude-Code-Plugins | Plugin-Cache-Dumps (396 Einträge) |
| 4 | `---\nname:` YAML-Frontmatter | hmem `fe619e0` | Bare Skill-Injektionen ohne Prefix |
| 5 | `# ` + >500 Zeichen | hmem `fe619e0` | Große Markdown-Doc-Injektionen |
| 6 | `/mcp`, `/clear`, `Restarted` | hmem `fe619e0` | Meta-Session-Exchanges |
| 7 | `<2 Zeichen`, Title-Gen-Prefix | Altbestand | Triviale Exchanges |

> **Design-Regel (2026-06-22):** Neue Guard-Muster werden ausschließlich
> per Content-Analyse auf `user_msg` definiert (nicht per Session-Metadaten).
> Inspiriert durch den intelligenten Filter aus `hmem/src/mcp-server.ts`
> (`fe619e0`, 2026-04-10, Opus 4.6), der dieselben Muster im Read-Pfad
> komprimiert. Der Write-Pfad-Filter ist strenger: Noise wird komplett
> abgewiesen, nicht komprimiert.

---


### Cold-Node-Kompression (R2 Detail)

Cold-Node = Entry mit `accessed_at` älter als Threshold (Store-intern, nicht Config-Toggle v1).
Mechanik:

1. **Tier Hot:** `accessed_at` < 30d — voller Content in SQLite, Summary gepflegt
2. **Tier Warm:** 30-90d — Content bleibt, Summary bevorzugt in `tim_read`/`load_project`
3. **Tier Cold:** >90d — Content ausgelagert nach `<db_path>.cold/<ulid>.gz`, Entry behält
   `summary` + Pointer in metadata `{ cold_storage: true, cold_path: "..." }`
4. **Exchange-Exception:** `kind: exchange` Nodes **nie** Cold-Tier Content-Delete — nur
   optional gzip inline wenn User explizit `tim config set compression.exchanges true`

Rehydration transparent: `tim_read(..., include_body=true)` lädt aus cold_path, setzt
`accessed_at` → Hot-Tier. Agent merkt nichts.

Sharding (R2): Pro Project optional eigene DB `<db_path>.d/<label>.db` — `tim_load_project`
öffnet nur relevante Shard. Cross-Project Edges via ULID in Master-Index.

### tim_read API Contract

```
tim_read({
  id: ULID | ULID[],
  depth: 1-5,              // subtree depth
  includeChildren: true,    // default true
  include_body: false,      // default false — nur summary+title
  includeEdges: false,
  showIrrelevant: false
})
```

Response pro Entry: `{ id, title, summary, content?, content_type, depth, confidence,
created_at, updated_at, accessed_at, visibility, tags, metadata, children?, edges? }`.
`content` nur wenn `include_body=true`. Children immer Summary-Level unless depth exhausted.

Batch-Read: `id: [ulid1, ulid2]` — single round-trip, shared tag_similarity cache.

## 6. Schemas — Type + Tree-Template (Generator-Ansatz)

Schemas definieren Feld-Constraints + **Tree-Templates**: welche Sub-Node-Types bei
`tim_new type="project"` auto-erzeugt werden.

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

Generator-Ansatz (R6): `tim_new(type="project")` erzeugt gesamten Sub-Tree. Nicht jeder
Type hat Schema. Pro Schema: Tree-Template, Defaults, Edge-Constraints. Siehe
`~/projects/tim/docs/project-schema.json`.

---

## 7. Session-Nodes — Root-Nodes mit Project-Links

**Breaking Change:** Sessions = eigenständige Root-Nodes, **nicht** Sub-Nodes eines Projects.
Verlinken per `implements`/`relates` zu Projekten.

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
- Sessions berühren mehrere Projekte
- Eigener Lifecycle (unabhängig von Project)
- Project-Subtree sauber (keine Session-Rohdaten in Project-Output)

**Ist-Stand Code:** Sessions noch Sub-Nodes (`P0063/Sessions/<session>`). Breaking Change
Root-Nodes geplant Phase 0.7 (R7). Siehe `session-system-plan.md`.

---

## 8. Session-Logging — Tree + Batch-System + Summarizer

### Architektur

Aktueller Code — Session-Architektur (Sub-Node-Variante, bis Phase 0.7):

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

Exchanges in **Batches** (default: 5 pro Batch). Jeder Batch → **Summarizer**
(externer CLI-Agent) thematisch zusammengefasst.

**Trigger:**
1. **Per-Batch:** `exchange_count - batches_summarized * batch_size >= batch_size`
   → Summarizer async (Stop-Hook)
2. **Manuell:** `/tim-handoff` → Summarizer on-demand

Sub-Node Sessions + Batch-System im Ist-Stand (R8). Summarizer async nach Batch-voll.
`/tim-handoff` on-demand. Data-Flow: `session-system-plan.md` §4.

### Tag-Standardisierung

Summarizer nutzt verschiedene Modelle (Haiku, DeepSeek-Flash) → inkonsistente Tags
(`#sqlite` vs `#database`). **`tim-summarizer` Tag-Normalization** vor Write:

1. Batch-Summary-Tags gegen existierende Tags in DB matchen (FTS/Tag-Index)
2. Config `summarizer.tag_normalization: true` (default) — Alias-Map + Fuzzy-Match
3. Neue Tags nur wenn kein Match über Threshold — dann in Summary-Metadata dokumentieren
4. `tim_show_untagged` findet Legacy-Batches ohne Content-Hashtags → Re-Tag-Cron

Ziel: Tag-Schicht 2 (IDF) stabil, nicht fragmentiert durch Modell-Wechsel.

### Privacy

Summarizer schickt **Roh-Exchanges** an externe CLI/Modell. Gleicher Inhalt den TIM-Sync
E2E-verschlüsselt — bei API-Modell verlässt unverschlüsselt das Gerät (DeepSeek +
Datenresidenz-Frage). **Privacy-sensible Setups:** lokaler Summarizer = empfohlener Default.
Config dokumentiert welche `cli`/`model`-Kombinationen lokal vs. Cloud. User explizit
bestätigen wenn Cloud-Summarizer aktiv.

### Concurrency

Summarizer = **separater Prozess** async, Haupt-Agent schreibt parallel in `tim.db`.
SQLite WAL: 1 Writer + N Reader — zwei Writer brauchen Serialisierung:

- Store: `busy_timeout` 5000ms + Retry mit Exponential Backoff
- Idempotentes `tim_write_batch_summary` (batch_index unique per Session) → Crash-Recovery
- Haupt-Agent hat Priorität: Summarizer retry bei SQLITE_BUSY, nie blockiert User-Turn
- Transaction-Scope minimal: Batch-Summary-Insert atomar, kein Long-Running-Lock

---

## 9. `.tim-project` Discovery — Streng CWD

**.tim-project Discovery: KEIN Walk-up. Nur CWD.** Sub-Dirs brauchen explizites
`tim project use <name>`.

**Warum:**
- Streng, null Magie
- Verhindert falsche Projekt-Erkennung in Sub-Dir anderem Projekt
- `tim project browse` listet Projekte, User wählt

**Ist vs. Soll:** Aktueller Code (`start-hook-plan.md`, `findMarker` in `marker.ts`) macht
**Walk-up** — Parent-Verzeichnisse bis Root. Pragmatisch während Implementierung; Benni
entschied später CWD-only. Breaking Change Phase 0.7 (R9).

CWD-only erhöht Reibung in tiefen Sub-Directories. CLI-Convenience: Shell-Session erbt
aktives Projekt, flüchtiges Cache `~/.tim/active-project` speichert letzte Zuordnung —
**ergänzt** CWD-only, ersetzt nicht `.tim-project` im Repo-Root.

### TIM_PROJECT ENV Override

`TIM_PROJECT=P0063` (oder Label/Alias) überschreibt Marker-Discovery für diese Shell-
Session. Nützlich für CI, Worker-Spawns, tmux ohne `.tim-project` in CWD.

Priorität: `TIM_PROJECT` env > `.tim-project` in CWD > Fehler „no project bound".
Kein Walk-up auch mit ENV — explizit oder nichts.

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

Erstellt durch:
1. **Handoff:** `/tim-handoff` → `tim bind-project --cwd <repo> --label P00XX`
2. **`tim hook session-start`:** bei explizitem Session-Binding
3. **Manuell/Committed:** `tim bind-project` oder committed im Repo

---

## 10. TIM-Sync — E2E-verschlüsselt mit Revocation

TIM-Sync = eigener E2E-Sync-Dienst (Bezahdienst geplant). Nicht o9k-Framework — klar
TIM-Produkt. Config `sync.server` zeigt auf TIM-Sync-Instanz (dev: `ws://localhost:3100`).

### Verschlüsselung

- **AES-256-GCM** Nutzdaten
- **scrypt** Key Derivation aus Passphrase
- Jedes Sync-Device eigener Key-Container
- Server sieht nur Ciphertext + Versionsnummern

### Passphrase-Speicherung

Klartext `passphrase` in `~/.tim/config.json` = E2E untergraben (Datei-Leser = Key).

**Priorität:**
1. **OS-Keychain** (macOS Keychain, libsecret, Windows Credential Manager) — Passphrase
   nie auf Disk
2. **Fallback `encrypted_passphrase`** in Config — scrypt-verschlüsselt mit Device-Key
   (Keychain oder TPM-backed). Config enthält nur Ciphertext + Salt + KDF-Params
3. **Prompt-on-first-sync** wenn weder Keychain noch encrypted_passphrase — einmalig TTY,
   dann Keychain speichern

Config-Key: `sync.encrypted_passphrase` (nicht `sync.passphrase` Klartext). Siehe §11.

### Revocation — Passphrase-Rotation + Per-Node-Key-Rotation

**Global Revocation (Passphrase-Rotation):**
1. Owner rotiert Passphrase → Server nur neue Versionsnummer
2. Clients alte Version → Diskrepanz (Config-Version != Server-Version)
3. Alte Clients entschlüsseln nicht mehr
4. E2E bleibt — Server sieht Versionsnummern, keine Inhalte

**Per-Node Revocation (granulares Sharing):**
- Geteilte Nodes haben eigenen Key in `shared_keys` (§ unten)
- Owner rotiert Per-Node-Key → nur dieser Node für Empfänger unlesbar
- Global-Passphrase-Rotation invalidiert nicht automatisch Per-Node-Keys — bewusst getrennt

### Per-Node-Sharing (`shared_keys`)

`TIM.md` fordert: einzelne Nodes (z.B. ein Projekt) mit anderen Usern teilen —
lesend/schreibend, **nicht löschbar**, ohne globale DB-Passphrase preiszugeben.

Config-Block:

```yaml
sync:
  shared_keys:
    - node_id: "01JX..."           # ULID des geteilten Nodes
      label: "P0063-shared"        # menschenlesbar
      key_id: "sk-001"             # Key-Version für Rotation
      permissions: [read, write]   # nie delete
      recipients: ["user@device"]  # Sync-Account-IDs
      encrypted_key: "..."         # Node-Key, mit Recipient-Public-Key wrapped
```

Visibility-Bitmask allein reicht nicht für „teile genau diese Node mit User X".
Per-Node-Key + `shared_keys` = granulares Sharing. Lease (§3) = temporärer **Agent**-
Zugriff, Sharing = persistenter **User**-Zugriff — verschiedene Mechanismen.

### Konflikt-Auflösung

Zwei Devices schreiben gleichzeitig denselben Node → selten, aber möglich offline.

**Default-Strategie: konfigurierbar pro Node-Type**

```yaml
sync:
  conflict_strategy:
    default: manual              # Owner entscheidet
    by_node_type:
      session: lww               # Last-Write-Wins für Session-Logs
      exchange: lww              # Exchanges append-only, LWW auf Metadata
      rule: manual               # Rules — Owner-Review Pflicht
      decision: manual
      project: manual
      config: manual
```

**`manual` Pfad:**
1. TIM-Sync broadcastet Conflict-Notification an Owner
2. Owner: „Dein Write / seins / merge?"
3. `tim sync resolve <ulid> --pick mine|theirs|merge`

**`lww` Pfad:**
- Vergleich `updated_at` (§3) — neuerer Write gewinnt
- Tie-Break: höhere `origin_device` seq oder ULID lexicographic
- Conflict-Log in Staging-Ledger für Audit

Intensive Offline-Arbeit auf mehreren Geräten → viele Konflikte. LWW-Default für
Session/Exchange verhindert CLI-Overload; kritische Nodes (Rules, Decisions) bleiben manual.

Sync noch Entwicklung (Phase 0.8, R10/R11). TIM-Sync-Server localhost:3100 dev.
Push/Pull implementiert; E2E + Revocation + shared_keys geplant.

---

## 11. Config — Alle 13 Keys selbsterklärend

TIM Config (`~/.tim/config.json`) — 13 Top-Level-Keys:

```yaml
# TIM Config — selbsterklärend, Defaults in Klammern

db_path: ~/.tim/tim.db
# Wann ändern: Custom-Pfad Multi-User, NAS, portable DB

node_types: [project, task, session, bug, lesson, user, rule, idea, decision, commit, milestone]
# Wann ändern: Custom-Type (z.B. "note", "feature", "epic")

edge_types: [relates, extends, implements, blocks, contradicts]
# Wann ändern: Custom-Edge-Type Domain-spezifisch (selten — Tags bevorzugt)

embedding_provider:
  type: none          # none | local | api  — local ONNX = Default sensible DBs
  model: ""           # Modell-Pfad oder API-Modell-Name
  api_key: ""         # Optional API-Key (nur type: api)
# Wann ändern: Embedding Phase 0.7 aktivieren

batch_size: 5
# Wann ändern: Exchanges pro Batch (1-50). Weniger = häufigere Summaries

summarizer:
  cli: claude         # CLI-Agent für Summaries
  model: haiku        # Modell
  tag_normalization: true   # Tag-Alias-Match vor Write (§8)
# Wann ändern: Anderen Summarizer (cursor, codex). Cloud = Privacy beachten

sync:
  server: ws://localhost:3100    # TIM-Sync-Server URL
  encrypted_passphrase: ""       # scrypt-verschlüsselt — NICHT Klartext passphrase
  version: 1                       # Passphrase/Key-Version für Revocation
  auto_sync: false
  conflict_strategy:
    default: manual
    by_node_type:
      session: lww
      exchange: lww
  shared_keys: []                  # Per-Node-Sharing (§10)
# Wann ändern: Multi-Device-Sync Phase 0.8

statusline:
  project: true
  batch_counter: true
  context_level: false    # Privacy — explizite Bestätigung nötig
  model: false
  provider: false
  db_path: false
  tool_count: false
# Wann ändern: Status-Felder ein/aus (Privacy)

mcp:
  port: 0                 # 0 = stdio, >0 = HTTP
  max_payload_size: 10485760
# Wann ändern: HTTP-MCP Remote-Agenten

hooks:
  pre_llm_call:
    - ~/.hermes/agent-hooks/o9k-startup.sh
    - ~/.hermes/agent-hooks/tim-session-start.sh
  post_llm_call:
    - ~/.hermes/agent-hooks/o9k-log-exchange.sh
  on_session_end:
    - /bin/bash -c 'exec node .../tim-cli/dist/cli.js checkpoint --session "$HERMES_SESSION_KEY"'
# Wann ändern: Custom-Hooks (Notion, Slack)

agent_registry:
  enabled: true
  default_visibility: 1   # 1=Owner, 3=Owner+Trusted, 7=Owner+Trusted+Leased
# Wann ändern: Multi-Agent Visibility

logging:
  level: info
  file: ~/.tim/tim.log
  max_size_mb: 50
# Wann ändern: Debug
```

13 Keys selbsterklärend (R15). `embedding_provider`, `sync` ab Phase 0.7/0.8 relevant.
Sinnvolle Defaults. **Kein** Cold-Node-Config-Block v1 — Cold-Node-Kompression
(R2) = Store-interner Mechanismus, nicht User-Toggle in v1.

---

## 12. Statusline — Opt-in per Feld, Privacy-First

TIM in Hermes-Statuszeile. **Opt-in pro Feld.**

**Config `statusline`-Block:**
- `project: true` — Aktives Project (Default)
- `batch_counter: true` — Batch-Status exchanges/summarized (Default)
- `context_level: false` — Kontext-Füllstand (Privacy — Bestätigung nötig)
- `model: false`, `provider: false`, `db_path: false`, `tool_count: false`

**Privacy-Regel:** Felder mit Rückschluss auf private Daten (`context_level` = Prompt-Füllstand)
default aus, explizite User-Bestätigung.

Implementiert via `tim statusline --format hermes` (R16). Siehe `tim-cli/src/cli.ts`.

---

## 13. Tools — Alle MCP-Tools im Überblick

TIM = **37 MCP-Tools**. Gruppiert nach Funktion.

### Negative Memory

Manche Entries/Prompts sollen Agent **dauerhaft ignorieren** — falsche Lessons, veraltete
Patterns, Noise aus Migration. **Negative Memory** = Suppress-Liste:

- `tim_suppress(pattern, reason, ttl?)` — Pattern (Regex oder FTS-Phrase) zu Negative Memory
- Matching Entries hidden aus `tim_search`, `tim_read` Related, `tim_load_project` Output
- TTL optional — permanent wenn omitted
- Curator kann via `tim_update` + `irrelevant` ergänzen; Suppress = soft-filter ohne DB-Delete
- Use-Case: „ignore all entries mentioning deprecated API X" nach Refactor

Negative Memory lebt in Store-Tabelle `suppress_patterns` — nicht in Entry-Tree.
`tim_health` reportet stale Patterns (TTL expired, zero matches).

### Agent Leasing (`tim_lease`) — *entfernt 2026-07-10*

> **Status:** Tool entfernt (Production-Readiness-Entscheidung). Grant war via MCP
> nicht nutzbar; Lease-Metadaten im Schema bleiben optional für spätere Phase 0.7+.

Temporärer Agent-Zugriff auf Entry ohne globale Visibility-Änderung (ursprüngliches Design):

- `tim_lease(entryId, grant=<agentId>, ttl=1h, scope=read|write)` — setzt
  `metadata.lease_holder`, `lease_expiry`, `lease_scope` + Visibility-Bit Leased (4)
- `tim_lease(entryId, revoke=<agentId>)` — cleared Lease-Felder
- Nach Expiry: Hook/Read-Path prüft `lease_expiry`, auto-revoke
- **Kein Edge-Type** — rein Metadata (§3, §4)
- Unterschied zu `shared_keys` (§10): Lease = Agent temporär, Sharing = User persistent

### load_project — Budget + Truncation

`tim_load_project` = heißester Pfad Kontext-Sparen. Große Projects können selbst
riesig werden → frisst Kontextfenster das TIM schonen soll.

**Budget-Strategie:**

| Parameter | Default | Wirkung |
|-----------|---------|---------|
| `budget` | 200 | Max Child-Entries returned |
| `depth` | 3 | Subtree-Tiefe |
| `sections` | null | Filter auf Section-Titles |

**Truncation-Priorität** (was immer rein, Rest lazy):
1. Project Root Summary + metadata.label
2. **Next Steps** Section — volle Summaries offener Tasks
3. **Tasks** — nur `status: todo|in_progress`, Summary only
4. **Bugs** — nur open, Summary only
5. **Rules** — pinned/favorite zuerst, dann recent
6. **Sessions** — nur letzte N Session-Summaries (nicht Exchanges)
7. **Codebase** — nur L2 Module-Titles, keine Function-Bodies
8. Rest: Title-only Listing, `tim_read` on-demand

Response enthält `_truncated: true` + `_truncated_sections: [...]` wenn Budget erreicht.
Agent weiß: mehr da, gezielt nachladen.

### Read/Query-Tools

| Tool | Beschreibung |
|------|-------------|
| `tim_read` | Entry + Children + optional Edges. Default Summary, `include_body` für Content |
| `tim_search` | FTS5 (+ optional hybrid Embedding) |
| `tim_trace` | Edge-Chain BFS, start + type + depth |
| `tim_health` | DB-Integrität: Broken Links, Orphans, FTS, suppress stale |
| `tim_stats` | Memory-Statistiken totals, depth, tags, confidence |
| `tim_doctor` | Diagnostics Config, DB, API, tag_frequency reconcile |
| `tim_load_project` | Project by Label laden + Session binden. Budget/Truncation (oben) |
| `tim_read_project` | Project OHNE Session-Binding (Cross-Project) |
| `tim_show` | Unified Overview tasks, errors, bugs, ideas, decisions, commits |
| `tim_show_unsummarized` | Nächster unsummarized Batch einer Session |
| `tim_show_all_unsummarized` | Alle unsummarized Batches aller Sessions |
| `tim_show_untagged` | Batch-Summaries ohne Content-Hashtags |
| `tim_error_stats` | Error-Statistiken totals, rate, alerts |

### Write/Update-Tools

| Tool | Beschreibung |
|------|-------------|
| `tim_write` | Entry schreiben (parentId oder parentTitle+projectId) |
| `tim_update` | Entry aktualisieren — setzt `updated_at` (auch Titel-Rename: `tim_update(id, title)`) |
| `tim_link` | Edge zwischen zwei Entries |
| `tim_delete` | Soft (irrelevant) oder hard (tombstone) |
| `tim_update_many` | Batch-Update flags: irrelevant, favorite |
| `tim_rename_entry` | Entry-ID atomar umbenennen + References |
| `tim_move_entry` | Parent verschieben + Depth-Cascade |
| `tim_write_batch_summary` | Idempotentes Batch-Summary |
| `tim_rollup_session_summary` | Batch-Summaries in Session-Summary-Root folden |
| `tim_tag_add` | Tags hinzufügen — updated tag_frequency |
| `tim_tag_remove` | Tags entfernen — updated tag_frequency |
| `tim_tag_rename` | Tag global umbenennen |

### Session/Admin-Tools

| Tool | Beschreibung |
|------|-------------|
| `tim_session_start` | Session starten idempotent |
| `tim_session_log` | Exchange an Session anhängen |
| `tim_record_commit` | Git-Commit unter Project/Commits |
| `tim_checkpoint` | Session-Checkpoint + integrity verify |
| `tim_create_project` | Project registrieren für load_project |
| ~~`tim_lease`~~ | *(entfernt 2026-07-10)* |
| `tim_suppress` | Pattern zu Negative Memory (§ oben) |
| `tim_export` | DB als .tim/.md exportieren |
| `tim_import` | .hmem importieren |
| `tim_sync` | Sync push/pull/status |
| `tim_error_log` | Error-Eintrag loggen |

Alle Tools in `~/projects/tim/packages/tim-mcp/src/server.ts` (R12). Input/Output Zod-Schemas dort.

---

## 14. Skills — 15 Published Skills

### TIM-Kern-Skills (10)

| Skill | Trigger | Zweck |
|-------|---------|-------|
| **tim-read** | "was war der letzte Stand", "continue where we left off" | Project laden, Memory lesen |
| **tim-write** | Entry-Erstellung | Entry schreiben Prefix/Tree/Tags |
| **tim-search** | Unbekannte Referenzen | FTS5 + Recall |
| **tim-recall** | Tiefe Suche | Sub-Agent Dispatch Memory Search |
| **tim-load-project** | Project-Referenz | tim_load_project vs tim_read_project, Budget |
| **tim-using** | Meta | Wann welches Tool + Habits |
| **tim-curate** | "aufräumen", "clean up memory" | irrelevant, titles, consolidate |
| **tim-new-project** | "register a new project" | Project + Schema + Sections |
| **tim-new-task** | "new task" | Task unter Project/Tasks |
| **tim-new-error** | Bug gefunden | Error Sub-Nodes + Schema |

### Meta-Skills (5)

| Skill | Trigger | Zweck |
|-------|---------|-------|
| **tim-config** | Config-Änderung | Config lesen/schreiben/validieren |
| **tim-update** | "update tim" | TIM npm update |
| **tim-release** | Release-Vorbereitung | Pre-Publish Checklist |
| **tim-handoff** | `/tim-handoff` | Session Ende + Summarizer + Marker |
| **tim-usage** | "usage check" | Subscription/Balance-Check |

10 Kern + 5 Meta = 15 published (R13). Plus 1-2 Dev-Skills gitignored.
Liegen in `~/.hermes/profiles/worker/skills/tim-*/`. `tim-config`, `tim-update`,
`tim-release`, `tim-handoff`, `tim-usage` teilweise Phase 0.7+.

---

## 15. Roadmap — 0.6 → 1.0

### Phase 0.6: Final Spec + Paper (AKTUELL)

**Acceptance Criteria:**
- [x] TIM Vision-Paper v2.0 geschrieben (dieses Dokument)
- [ ] Paper von Benni reviewed als „Mein Soll-Zustand"
- [ ] Code-Bestandsaufnahme: was fehlt noch zum Paper?

### Phase 0.7: Embeddings + Sharing (Next)

**Acceptance Criteria:**
- [ ] Embedding-Provider lokal (ONNX default) + API opt-in
- [ ] Schicht 3 on-demand, Schicht 2+3 hybrid in `tim_search`
- [ ] `summary` + `updated_at` Felder in entries (§3)
- [ ] tag_frequency Tabelle + incremental df
- [ ] Session-Nodes Root-Nodes (Breaking R7)
- [ ] `.tim-project` CWD-only + TIM_PROJECT env (Breaking R9)
- [ ] `tim-migrate` Rewrite (R18)
- [ ] o9k-Skills → TIM-Skills Übergang (R19)
- [ ] `tim-config`, `tim-update`, `tim-release` Skills
- [ ] summarizer.tag_normalization
- [ ] load_project Budget/Truncation

### Phase 0.8: TIM-Sync Public Beta

**Acceptance Criteria:**
- [ ] TIM-Sync-Server Strato VPS
- [ ] E2E AES-256-GCM + scrypt
- [ ] encrypted_passphrase + OS-Keychain
- [ ] Passphrase-Rotation + Per-Node-Key-Rotation (R10)
- [ ] shared_keys Per-Node-Sharing
- [ ] conflict_strategy manual/lww per node-type (R11)
- [ ] Auto-Sync Session-Ende
- [ ] `tim-sync-client` Package
- [ ] Sync-Tests 200+ (hmem v2 Branch portiert)

### Phase 0.9: Doku + Onboarding + E2E-Tests

**Acceptance Criteria:**
- [ ] README Quick-Start (install → init → use)
- [ ] CLI Reference vollständig
- [ ] MCP Tool Reference (Paper + server.ts)
- [ ] Skill-Doku SKILL.md + Beispiel je Skill
- [ ] E2E: Session-Start → Exchange → Batch → Summary → Rollup
- [ ] E2E: TIM-Sync Push → Pull → Reconcile
- [ ] E2E: hmem → TIM Migration Dry-Run + Real
- [ ] 200+ Tests gesamt

### Phase 1.0: Public Release

**Acceptance Criteria:**
- [ ] npm publish (`tim-mcp`, `tim-cli`, `tim-core`)
- [ ] GitHub Release Notes
- [ ] Docs Getting Started + Architecture + API + Examples
- [ ] Brew/apt-get optional
- [ ] Ankündigung HN, Reddit

5 Phasen, kein 3.0 Endziel (R17). Phase 0.6 aktuell — dieses Paper = Output.

---

## 16. hmem-Migration — `tim-migrate` überarbeiten

**hmem (its-over-9k)** = Vorgänger. Aktueller `tim-migrate` muss **komplett überarbeitet**
werden (eigener Task P0063).

### Entry-Mapping

| hmem | TIM |
|------|-----|
| Entry ID `P0001` | Entry ID `P0001` (Prefix bleibt typ-spezifisch) |
| — | `metadata.hmem_id: P0001` wenn Remap nötig |
| Prefix (P/L/E/T/D/M) | `metadata.type` + `metadata.label` |
| 5-Level-Hierarchie | `parent_id` + `depth` (1-5) |
| Links (string[]) | Edges `type=relates` |
| Tags (#sql) | Tags JSON-Array (nicht Edge) |
| O-Entries (Session-Log) | Session-Nodes + Exchanges |
| hmem-sync | TIM-Sync kompatibles Protokoll Transition |

**Kurz-ID:** Prefix bleibt menschenlesbar (`P0001`→`P0001`). Nicht alles zu generischem
`E####` — Type-Erkennbarkeit aus TIM.md erhalten. Bei ULID-Kollision: neue ULID + `metadata.hmem_id`.

### Edge-Mapping (9 → 5)

| hmem (alt) | TIM (neu) |
|------------|-----------|
| relates | relates |
| extends | extends |
| implements | implements |
| blocks | blocks |
| contradicts | contradicts |
| tagged | → Tags (kein Edge) |
| summarizes | → Tags + metadata |
| leases | → Node metadata (`lease_holder`, `lease_expiry`, `lease_scope`) — **kein Edge** |
| session_exchange | → Session-Nodes + Edges relates/implements |

hmem `leases` Edge-Type → TIM Node-Metadata. Kein sechster Edge-Type.

### Migration-Befehl

```bash
tim migrate --from ~/.hmem/personal.hmem --to ~/.tim/tim.db [--dry-run]
```

**Dry-Run:** Counts, Mapping-Preview, Kollisions-Report. **Real:** Transaction-batched,
hmem-DB bleibt Backup. Staging-Ledger für Rollback.

Aktueller `tim-migrate` in `packages/tim-migrate/` unvollständig (R18). P0063/Tasks Stand.

---

## 17. o9k-Abgrenzung — Framework vs. Memory

**o9k (its-over-9k)** = **Framework** (Skills, Cron, Orchestrierung).
**TIM** = **Memory** (Datenbank, TIM-Sync, Embedding).

```
o9k = Framework  │  TIM = Memory
─────────────────┼────────────────
Skills (o9k-*)   │  Skills (tim-*)
Cronjobs          │  Store (SQLite)
Orchestrierung    │  TIM-Sync
Session-Management│  Embeddings
                  │  Search
```

Beide Skill-Familien parallel:
- `o9k-*` = Framework (orchestrieren, delegieren)
- `tim-*` = Memory (lesen, schreiben, suchen, curaten)

**Memory-Interface:** Default hmem (Abwärtskompatibilität). Config-Switch
`memory_interface: "tim"` → TIM.

| o9k-Skill | TIM-Äquivalent | Status |
|-----------|----------------|--------|
| o9k-read | tim-read | Parallel |
| o9k-write | tim-write | Parallel |
| o9k-search | tim-search | Parallel |
| o9k-new-project | tim-new-project | TIM neuer |
| o9k-new-error | tim-new-error | TIM neuer |
| o9k-curate | tim-curate | TIM neuer |
| o9k-recall | tim-recall | TIM neuer |

o9k-Skills bleiben `o9k-*`, TIM hat `tim-*` (R19). o9k referenziert austauschbares
`o9k-memory-interface` Paket. TIM-Sync ≠ o9k — Sync gehört TIM-Produkt (§10).

---

## 18. YAML-Schema-Beispiele

### Project

```yaml
# schemas/project.yaml
type: project
kind: project
label: P0063
title: "TIM — Theoretically Infinite Memory"
tags: [project, memory, mcp, agent, planning]
metadata:
  status: active
  created_at: "2026-05-29"
  packages: 10
  tests: 101
summary: "7-Package-Workspace TIM. Phase 0.6 Vision-Paper. Next: 0.7 Embeddings."
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
    - Testing: {}
    - Sessions:
        kind: sessions-root
        render_depth: 0
        order: 1000
    - Commits:
        render_tail: true
```

### Task

```yaml
type: task
kind: task
parent_title: Tasks
title: "Implement Embedding Provider"
tags: [task, phase-0.7, embedding]
metadata:
  task:
    status: todo
    priority: high
    due: "2026-07-15"
    estimate: medium
  phase: 0.7
summary: "ONNX local default + API opt-in. Hybrid search tim-search."
body: |
  ## Background
  TIM needs embedding support for semantic search (Schicht 3).
  ## Scope
  - EmbeddingProvider Interface tim-core
  - Local ONNX (all-MiniLM-L6-v2)
  - API provider OpenAI
  - Hybrid FTS5 + Embedding
  ## Steps
  1. Interface tim-core
  2. Local ONNX provider
  3. API provider
  4. Hybrid tim-search
  5. Tests
```

### Session

```yaml
type: session
kind: session
title: "2026-06-17-1123"
tags: [session]
metadata:
  session:
    session_id: "01JX..."
    project_ref: "P0063"
    agent: "deepseek-v4-flash"
    harness: "hermes"
    date: "2026-06-17T11:23:00Z"
    batch_size: 5
    exchange_count: 14
    batches_summarized: 2
summary: "Vision paper finalized. 10 design decisions applied."
children:
  - Summary:
      kind: session-summary-root
      tags: [session-summary]
  - Exchanges:
      kind: exchanges-root
      render_depth: 0
```

### Rule

```yaml
type: rule
kind: rule
parent_title: Rules/Agent Rules
title: "Kein direktes SQL auf tim.db"
tags: [rule, critical, database]
metadata:
  rule:
    applies_to: [all_agents]
    severity: critical
summary: "Nur TIM MCP Tools für DB — kein sqlite3 terminal."
body: |
  NIEMALS direktes SQL auf ~/.tim/tim.db — kein sqlite3.
  Nur TIM MCP Tools (tim_read, tim_search, tim_write, tim_update,
  tim_load_project, tim_read_project) für DB-Zugriff.
  Raw SQL bypassed WAL, integrity checks, tree-structure — corruption risk.
```

### User

```yaml
type: user
kind: user
title: "bbbee"
tags: [user, admin]
metadata:
  user:
    role: owner
    preferred_language: de
    preferred_model: deepseek-v4-flash
    communication_style: concise
    aliases: [Benni, Bumblebiber]
```

---

## 19. History-Notes

19 Design-Entscheidungen grill-me 2026-06-17.

### R1 — Ziel des Papers

**Decision:** Eigenständiges Vision-Paper, ersetzt/ergänzt `tim-design.md`. Code zitiert,
nicht Source of Truth.

**Warum:** Benni wartet kompetenteres KI-Modell — Code fertig oder Greenfield. Paper =
Briefing kontextfrei + vollständig.

**Konsequenz:** §1 Vision.

### R2 — Storage-Backend + Cold-Node-Kompression

**Decision:** SQLite + FTS5. Scaling via Projekt-Sharding + **Cold-Node-Kompression**
(abgeleitetes Wissen komprimiert/ausgelagert; Roh-Exchanges nie gelöscht).

**Warum:** Lokal, kein Server-Pflicht, FTS5, WAL concurrent reads.

**Konsequenz:** Keine DB-Abstraktion v2. `better-sqlite3`. §3 Entry-Struktur. Kein
Kein Wissens-Verfall — Cold-Node-Kompression = R2 Mechanik.

### R3 — Drei-Schichten-Graph

**Decision:** (1) Edges, (2) Tag-TF-IDF on-read, (3) Embedding on-demand/lokal.

**Warum:** Bennis Neuronales-Netz-Metapher. Schicht 3 optional, Writes billig.

**Konsequenz:** embedding_provider Config. §5.

### R4 — Edge-Types Minimal-Set

**Decision:** 5 Types: relates, extends, implements, blocks, contradicts. Rest Tags.

**Warum:** Tags = User-Filter. 5 reichen 95%.

**Konsequenz:** tim-migrate 9→5. Leases = Metadata nicht Edge. §4.

### R5 — Node-Types konfigurierbar

**Decision:** 11 Types, Config-erweiterbar, nicht hard-coded.

**Warum:** hmem-Kompatibilität + Custom-Types.

**Konsequenz:** node_types Config. §3.

### R6 — Schemas Generator

**Decision:** Type + Tree-Template. `tim_new` erzeugt Sub-Tree.

**Konsequenz:** schemas/<type>.yaml. §6.

### R7 — Session Root-Nodes

**Decision:** Sessions Root-Nodes, Edge zu Projects. Breaking Change.

**Konsequenz:** Phase 0.7. §7.

### R8 — Summarizer Trigger

**Decision:** Per-Batch + manuell `/tim-handoff`. show_unsummarized bounded.

**Konsequenz:** §8.

### R9 — CWD-only Discovery

**Decision:** Kein Walk-up. TIM_PROJECT env override.

**Konsequenz:** Phase 0.7. §9.

### R10 — Sync Revocation

**Decision:** Passphrase-Rotation + Per-Node-Key-Rotation. TIM-Sync Branding.

**Konsequenz:** §10.

### R11 — Sync Konflikte

**Decision:** manual default, LWW configurable per node-type.

**Konsequenz:** conflict_strategy Config. §10.

### R12 — 37 Tools dokumentiert

**Decision:** Alle MCP-Tools einzeln. Paper = Tool-Reference.

**Konsequenz:** §13 inkl. Negative Memory, Leasing, Truncation.

### R13 — 15 Skills

**Decision:** 10 tim-* + 5 Meta. 1-2 Dev gitignored.

**Konsequenz:** §14.

### R14 — 10 Packages

**Decision:** Architektur unverändert.

**Konsequenz:** §2.

### R15 — 13 Config Keys

**Decision:** Selbsterklärend, Defaults, wann ändern. Kein REM-Config.

**Konsequenz:** §11 encrypted_passphrase, tag_normalization.

### R16 — Statusline Privacy

**Decision:** Opt-in pro Feld.

**Konsequenz:** §12.

### R17 — Roadmap 5 Phasen

**Decision:** 0.6→1.0, kein 3.0.

**Konsequenz:** §15.

### R18 — tim-migrate Rewrite

**Decision:** hmem→TIM, leases→Metadata, Prefix bleibt.

**Konsequenz:** §16.

### R19 — o9k vs TIM

**Decision:** Framework vs Memory. TIM-Sync = TIM Produkt.

**Konsequenz:** §17.

---

## Referenzen

- **Codebase:** `~/projects/tim/`
- **TIM Design (alt):** `~/projects/tim/docs/tim-design.md`
- **Session System Plan:** `~/projects/tim/docs/session-system-plan.md`
- **Start Hook Plan:** `~/projects/tim/docs/start-hook-plan.md`
- **Project Schema:** `~/projects/tim/docs/project-schema.json`
- **P0063 in TIM:** Aktives TIM-Project
- **hmem (Vorgänger):** `~/projects/hmem/`
- **Skills:** `~/.hermes/profiles/worker/skills/tim-*/`
- **Config:** `~/.tim/config.json`
- **DB:** `~/.tim/tim.db`



---

## Anhang A — TIM-Sync Protokoll (Skizze)

TIM-Sync = WebSocket + REST Hybrid. Client `tim-sync-client`, Server `tim-sync`.

**Push-Flow:**
1. Client berechnet Merkle-Root lokaler entries + edges
2. Server vergleicht Root — sendet Diff-ULIDs
3. Client sendet Staging-Records (encrypted blobs) nur für Diff
4. Server merged in LWW-Register, broadcastet an andere Devices

**Pull-Flow:** Inverse. Conflict → staging conflict flag, Owner resolve.

**Encryption-Envelope:**
```json
{
  "version": 1,
  "key_id": "global|sk-001",
  "nonce": "...",
  "ciphertext": "...",
  "ulid": "01JX...",
  "updated_at": "2026-06-17T12:00:00Z"
}
```

Per-Node-Keys: separate `key_id` in envelope, `shared_keys` Config.

---

## Anhang B — Implementierungs-Checkliste Paper vs Code

| Feature | Paper § | Code Ist-Stand | Phase |
|---------|---------|----------------|-------|
| summary Feld | §3 | fehlt | 0.7 |
| updated_at | §3 | fehlt | 0.7 |
| tag_frequency | §5 | fehlt | 0.7 |
| Session Root-Nodes | §7 | Sub-Nodes | 0.7 |
| CWD-only Discovery | §9 | Walk-up | 0.7 |
| TIM_PROJECT env | §9 | fehlt | 0.7 |
| encrypted_passphrase | §11 | Klartext sync.passphrase | 0.8 |
| shared_keys | §10 | fehlt | 0.8 |
| conflict_strategy | §10 | fehlt | 0.8 |
| load_project truncation | §13 | partial budget | 0.7 |
| tim_suppress | §13 | implementiert | ✓ |
| Negative Memory docs | §13 | this paper | ✓ |
| tag_normalization | §8/§11 | fehlt | 0.7 |
| 5 Edge-Types only | §4 | implementiert | ✓ |
| leases as metadata | §3/§4 | tim_lease entfernt (2026-07-10) | 0.7+ wenn Bedarf |

Diese Tabelle = Übergabe an implementierendes Modell. Paper = Soll, Tabelle = Gap-Analyse.

---

## Anhang C — Glossar

| Term | Bedeutung |
|------|-----------|
| **Cold-Node** | Entry Content ausgelagert, Summary hot — R2 Kompression |
| **Exchange** | Raw User/Agent Message in Session-Tree, nie gelöscht |
| **Kurz-ID** | metadata.label z.B. P0063 — nicht PK |
| **Lease** | Temporärer Agent-Zugriff via metadata lease_* |
| **Negative Memory** | tim_suppress Patterns — hide from search/read |
| **Shard** | Project-eigene DB-Datei für Scale |
| **Staging-Ledger** | Sync-Puffer vor Merge, Conflict-Audit |
| **Summary** | Lazy-Load Kurztext — ersetzt nicht Exchange-Original |
| **TIM-Sync** | E2E Sync-Dienst — TIM Produkt, nicht o9k |
| **Truncation** | load_project Budget — kontext-sparend |


---

## Anhang D — Agent-Habits (tim-using Skill Kern)

Agent der TIM nutzt — Pflicht-Habits:

1. **Session-Start:** `tim_load_project` oder `tim_session_start` — nie blind coden ohne Project-Binding
2. **Read before Write:** `tim_read` / `tim_search` bevor neue Entry — Duplikate vermeiden
3. **Summary-first:** Default `include_body=false` — Body nur wenn nötig
4. **Tags konsistent:** Bestehende Tags wiederverwenden — Schicht 2 IDF stabil
5. **Tasks metadata.status:** `#todo`/`#done` Tags deprecated — `metadata.task.status` Source of Truth
6. **Kein Raw SQL:** Nur MCP Tools — R-Entry Regel
7. **Handoff:** `/tim-handoff` vor Session-Ende — Summaries + Marker
8. **Cross-Project:** `tim_read_project` — nie mid-session `tim_load_project` auf anderes Project
9. **Suppress statt Delete:** Veraltetes Wissen `tim_suppress` oder `irrelevant` — nicht hard-delete ohne Grund
10. **Checkpoint:** `tim_checkpoint` bei langen Sessions — integrity verify

Worker/Orchestrator-Pattern (Hermes): TIM-Tasks in Project/Tasks, Commits via `tim_record_commit`,
Session-Exchanges auto via Hooks. Memory = TIM, Framework = o9k — nicht vermischen.

---

## Anhang E — FTS5 + Hybrid Search

**FTS5 (Schicht 1 Search):** `entries_fts` virtual table — title + content + summary indexed.
Triggers on INSERT/UPDATE. `tim_search` default mode `fts`.

**Hybrid (Phase 0.7):** `searchType: hybrid` — weighted merge:
```
score = α * fts_rank + (1-α) * cosine_sim
```
Default α=0.6 text-heavy queries, α=0.4 semantic. Config `search.hybrid_alpha`.

**Vector table:** `entry_embeddings(ulid, model_id, vector BLOB)` — lazy populate on first
semantic search or batch job `tim embed --all`. ONNX local = no egress.

