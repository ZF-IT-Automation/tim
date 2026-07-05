# Plan 12: Memory-Power & Produkt-Richtung (Retrieval, Konsolidierung, Secret Nodes, Silbertablett)

Status: DRAFT — Richtungsplan (2026-07-04, Fable 5 auf Bennis Anfrage).
Anders als Plan 1–11 ist das KEIN task-level Implementierungsplan, sondern die
Detailplanung der „TIM soll das beste Memory-System werden"-Richtung inkl.
Hosted-Service-Strategie. Jedes Arbeitspaket (A–E) bekommt vor Umsetzung einen
eigenen Implementierungsplan im Stil von Plan 1–11 (A braucht zusätzlich die im
Index geforderte Brainstorming-Session zu Block 8 / Phase 0.7).

## Kollisions-Check gegen Plan 5–11 (geprüft 2026-07-04)

| Offener Plan | Verhältnis zu Plan 12 |
|---|---|
| 5 HTTP-Multiclient | **Voraussetzung** für E (Hosted Endpoint). Keine Überschneidung. |
| 6 Sync-Hardening | **Voraussetzung** für C (Secret Nodes bauen auf gehärtetem Staging/LWW auf). |
| 7 Package-Cleanup | Unabhängig. A legt Embeddings NICHT in ein neues Package (tim-search bleibt gelöscht) — in tim-store. |
| 8 Memory-Trust | Ergänzt A: `verified_at`-Staleness wird Ranking-Signal. Keine Doppelung. |
| 9 Write-Dedup | B (Konsolidierung) ist das Offline-Gegenstück zum Write-Gate; **reuse `findSimilar()`**. |
| 10 Usage-Feedback | `entry_usage` wird das Decay-Signal für B und ein Ranking-Signal für A. **Nicht duplizieren.** |
| 11 Recall-Tools | D (Silbertablett-Hooks) ruft `tim_guard`/`tim_delta` auf statt eigene Queries zu bauen. |

Migrationsnummern: NICHT hartkodieren — Plan 6 belegt v8, Plan 10 v9;
Plan-12-Pakete nehmen die jeweils nächste freie Version.

---

## A. Hybrid-Retrieval (Produktkern)

**These:** FTS5 allein verliert gegen jedes Vektor-RAG. TIMs Differenzierung
ist der Hypergraph — also nicht „Vektoren nachrüsten", sondern drei Signale
kombinieren:

1. **FTS5** (exakt, vorhanden) — Kandidaten-Generator.
2. **Embeddings** via `sqlite-vec`-Extension + lokalem Embedding-Modell
   (fastembed/ONNX o. ä. — kein API-Zwang, local-first bleibt wahr; optional
   API-Embeddings als Opt-in für Qualität). Neue Tabelle `entry_vectors`,
   device-lokal wie `entry_usage` — Vektoren werden NICHT gesynct, jedes
   Device embeddet selbst (spart Sync-Volumen, umgeht Modell-Versionskonflikte,
   und ist Voraussetzung für C: Secret-Inhalte verlassen das Gerät nie).
3. **Graph-Boost:** Treffer, die per Edges nah am aktiven Projekt/aktuellen
   Kontext hängen, steigen; dazu Signale aus Plan 8 (Staleness senkt) und
   Plan 10 (Usage hebt). Deterministisches Re-Ranking wie in Plan 10 —
   erklärbar, testbar, kein ML-Blackbox-Scoring.

Dazu gehört **summary-first read** (Block 8): `tim_read`/search-Ergebnisse
liefern Summary + `include_body`-Nachlade-Option. Embedding-Berechnung läuft
im Hintergrund (Hook/Sleep-Job, siehe B), nie im Write-Pfad.

**Messbarkeit:** Retrieval-Benchmark-Harness (eigene Golden-Queries + Lauf
gegen LongMemEval-artige Suites). „Bestes Memory-System" muss eine Zahl sein,
sonst ist es Marketing-Prosa. Benchmark-Ergebnisse werden Teil der CI-Doku.

## B. Konsolidierung — „Schlaf-Job" (Differenzierung)

Nächtlicher Wartungslauf, der das Gedächtnis verdichtet statt nur wachsen zu
lassen. **Kosten-Grundsatz: deterministisch zuerst, LLM zuletzt** (→ Abschnitt
„Kostenstrategie"):

- **Stufe 1 (kein LLM, ~kostenlos):** Near-Dup-Erkennung via Plan-9-
  `findSimilar` + Embedding-Ähnlichkeit aus A; Decay-Kandidaten via Plan-10-
  `entry_usage` (lange nicht gelesen, nie referenziert, stale nach Plan 8);
  Verwaisten-/Konsistenz-Checks (doctor-Erweiterung). Ergebnis ist eine
  **Vorschlagsliste** (Curation-Queue-Node im Projekt), KEINE Auto-Löschung.
- **Stufe 2 (kleines/billiges Modell, gebatcht):** Merge-Texte für bestätigte
  Duplikate formulieren, wiederkehrende Fehler-Muster zu Learnings/Rules
  befördern. Läuft über die vorhandene Summarizer-CLI-Fallback-Chain — also
  auf den **Abos, die der User schon bezahlt**, nicht auf gemeterter API.
- **Auto ohne Rückfrage nur:** Decay = `irrelevant`-Flag (reversibel, Plan 1
  hat Restore gefixt), niemals Tombstone; exakte Duplikate mergen.

## C. Secret Nodes — das Hybrid-E2E-Modell (Hosted-Voraussetzung)

Bennis Kombi-Idee: nicht „ganze DB blind ODER ganze DB lesbar", sondern
**Vertraulichkeit pro Node/Subtree**:

- `metadata.secret: true`, **vererbt über den Subtree** (Projekt „Privat"
  markieren = alles darunter secret). Effektiver Secret-Status wird beim
  Sync-Envelope-Bau berechnet, nicht pro Read.
- Secret-Nodes gehen in den Sync-Envelope **nur clientseitig verschlüsselt**
  (vorhandenes AES-256-GCM/scrypt aus tim-sync-client): `title`+`content`+
  `metadata`-Payload chiffriert, Struktur (id, parent, Timestamps für LWW)
  bleibt klar — sonst funktioniert Merge nicht. Server-FTS/-Index sieht für
  diese Rows NICHTS (leerer Indexeintrag).
- Nicht-secret Nodes gehen im Klartext zum Server → serverseitige Features
  (Hosted-Suche, Team-Sharing, Web-UI) funktionieren für alles Unmarkierte.
- Embeddings für Secret-Nodes existieren nur lokal (folgt gratis aus A:
  Vektoren syncen nie).
- Später (Team-Tier): shared keys pro Subtree — bereits als Roadmap 0.8 in
  den Capabilities angelegt, hier NICHT vorziehen.

Abhängigkeit: Plan 6 zuerst (Staging/LWW-Härtung), sonst härtet man ein
kaputtes Protokoll.

## D. Silbertablett — alles in den Hintergrund (Adoption)

Ziel: Ein schwaches Modell muss TIM kaum „bedienen können", weil TIM liefert,
ohne gefragt zu werden. Drei Hook-Stufen (alle mit Zeit-Budget + Kill-Switch,
Fehler dürfen NIE den User-Flow blockieren):

1. **SessionStart** (existiert): Projekt-Briefing. Erweitert um `tim_delta`
   („seit deiner letzten Session hat sich X geändert") aus Plan 11.
2. **UserPromptSubmit** (neu): Hybrid-Retrieval aus A über den Prompt-Text,
   Top-3-Treffer als Kontext injizieren („TIM erinnert: …"), inkl. Guard-
   Treffer (`tim_guard`, Plan 11) wenn der Prompt nach einer Aktion aussieht,
   die schon mal schiefging. Latenz-Budget ~1s, sonst skip.
3. **PostToolUse** (später, optional): Nach Edit/Read einer Datei bekannte
   Learnings/Decisions zu genau dieser Datei injizieren (Provenance-Daten aus
   Plan 8 machen das Matching möglich).

**Zero-Config-Autonomie („installieren und einfach weiterarbeiten"):**
Der User soll TIM nie explizit bedienen müssen — die Agenten managen alles:

- **Auto-Init:** Erster Start des MCP-Servers legt DB + Config selbst an
  (existiert in Teilen via `tim init` — Ziel: init wird überflüssig, der
  Server bootstrappt sich beim ersten Connect).
- **Auto-Projekt:** SessionStart-Hook in einem Verzeichnis ohne
  `.tim-project`-Bindung → Projekt-Node wird automatisch angelegt (Label aus
  Repo-/Verzeichnisname, Standard-Sections aus project-schema). Kein
  Nachfragen; falsch angelegte Projekte sind per `irrelevant` reversibel und
  der Schlaf-Job (B) räumt Karteileichen auf.
- **Auto-Klassifikation:** Die Tool-Descriptions + Skills instruieren den
  Agenten, Decisions/Bugs/Learnings/Commits **unaufgefordert** zu erfassen
  („wenn du einen Bug fixst, schreib die Bug-Node — frag nicht"). Leitplanken
  dagegen, dass das Müll produziert, existieren dann schon: Write-Dedup
  (Plan 9), Suppress (Plan 1), Konsolidierung (B).
- Faustregel: **Jede Frage an den User ist ein Bug.** Wo heute eine
  Config-Entscheidung nötig ist, braucht es einen Default + Reversibilität
  statt eines Prompts.

**Update-Benachrichtigung:** Beim SessionStart-Hook (bzw. Sync-Lauf) ein
gedrosselter Versions-Check (max. 1×/Tag, npm-Registry bzw. im Hosted-Fall
die Server-Response), Ergebnis als eine Zeile im Briefing: „TIM x.y verfügbar
(installiert: x.z) — `npm i -g @…/tim`". Kein Auto-Update, kein Blockieren,
Opt-out per Config (`updateCheck: false`) — der Check ist der einzige
„Phone-Home" im Local-first-Modus und muss deshalb transparent + abschaltbar
sein.

**Erklär-Skill (`tim-explain`):** Wenn der User doch Fragen hat („was kann
TIM?", „wie funktionieren Secret-Nodes?"), beantwortet der Agent sie aus
einer **mitgelieferten** Wissensquelle statt aus Trainingsdaten-Halbwissen:
`docs/tim-capabilities.md` wird Teil des npm-Pakets, der Skill sagt dem
Agenten nur, wo sie liegt, wie er live-Zustand dazuholt (`tim_health`,
`tim doctor`, `tim_stats`) und dass er bei Diskrepanz der Doku glaubt, die
zur installierten Version gehört. Eine Quelle, versioniert mit dem Code —
kein zweites Handbuch, das driftet.

**Skills für schwächere Modelle:** Skills werden Teil des TIM-Repos und
`tim init` installiert sie (analog mcp.json): ein kurzes `tim-using`
(Entscheidungstabelle: wann write/read/search, mit je EINEM Beispiel-Call),
`tim-remember`, `tim-session-start`. Regeln: max ~50 Zeilen pro Skill,
Beispiel-getrieben statt Prosa, keine Tool-Duplikation der MCP-Descriptions —
die Descriptions selbst sind bereits der primäre Lehrtext (Plan 4 hat die
Surface dafür aufgeräumt). Messlatte: Haiku-Klasse-Modell kann nach Skill-
Lektüre die 5 Kern-Flows fehlerfrei (Testfall im Golden-Task-Stil).

## E. Hosted MCP Endpoint (Monetarisierung)

Produkt ist nicht „DB-Hosting", sondern: **eine URL, die jedem Agenten
Gedächtnis gibt.** Anmelden → MCP-URL in die Agent-Config → fertig.

- **Tier 1 „Blind Sync"** (früh machbar): Server = verschlüsseltes Backup +
  Multi-Device-Sync (heutiger tim-sync-server + Auth/Quotas/Tenant-Isolation;
  eine SQLite-DB pro Tenant ist dabei ein Feature, kein Hack). Privacy-USP:
  „Wir können dein Gedächtnis nicht lesen."
- **Tier 2 „Hosted Memory"**: gehosteter tim-mcp im HTTP-Modus, Klartext-Nodes
  serverseitig durchsuchbar, Secret-Nodes (C) bleiben blind. Harte
  Voraussetzung: Plan 5 (per-Connection-Kontext) fertig UND auf Mandanten
  verallgemeinert (Kontext = (tenant, connection), niemals Prozess).
- **Tier 3 „Team Memory"** (später): geteilte Projekt-Graphen, shared keys.
- **Kostenstrategie** (Bennis Einwand — wer pflegt die Memories?):
  1. Wartung ist zu ~80 % deterministisch (B Stufe 1) → läuft serverseitig
     fast kostenlos bzw. lokal beim User.
  2. LLM-Wartung läuft **beim Kunden** über dessen vorhandene Agent-Abos
     (Summarizer-Fallback-Chain-Muster) — TIMs bestehende Architektur ist
     hier zufällig genau richtig: der Server muss nie selbst denken.
  3. Wo Hosted-LLM doch gewünscht ist (Tier 2 Komfort-Feature): **BYOK**
     (Kunde bringt API-Key) oder gemetertes Add-on — nie aus der Flat-Marge.

## F. hmem-Erbe — Feature-Gap-Analyse (~/projects/hmem, geprüft 2026-07-04)

TIM wurde aus hmem heraus designt (docs/tim-design.md im hmem-Repo), die
meisten hmem-Konzepte sind also bewusst übernommen oder ersetzt worden.
Der Abgleich gegen den heutigen hmem-Stand findet aber sechs Dinge, die
hmem hat und TIM (noch) nicht — alle klein, alle passen unter D:

1. **User-Model (H-Schema).** hmem pflegt strukturiertes Wissen über den
   *Menschen*: Identität, Skill-Kalibrierung pro Domäne (1–10 mit
   Kalibrierungs-Legende), Arbeitsstil, Kommunikations-Präferenzen,
   Lebenskontext. TIM hat kein Pendant — dabei ist genau das die Grundlage
   für die Sekretärs-Vision (due-reminders-plan) und fürs Silbertablett:
   ein Agent, der weiß „User kann Architektur 9/10, TypeScript 3/10",
   kalibriert Erklärtiefe automatisch. Umsetzung: kein Schema-Change —
   ein konventionierter Baum (`kind=human`-Nodes unter einem User-Root),
   Pflege durch den Schlaf-Job (B) und Auto-Klassifikation (D).
2. **Handoff-Kontrakt.** hmems `o9k-handoff` (vor `/clear`: Git-Dirty-Gate,
   High-Value-Wissen sichern, Next-Steps so schreiben, dass die nächste
   Session *besser* startet) plus die Checkpoint-„Handoff-Note"
   (erledigt / in Arbeit / nächster Schritt) am Projekt. TIM hat
   Session-Summaries, aber keinen expliziten Handoff-Vertrag. Umsetzung:
   `tim-handoff` in die Skill-Suite (D), Handoff-Note als Teil von
   `tim_checkpoint`.
3. **Skill-Verteilmechanismus.** hmem shippt seine Skills im npm-Paket und
   synct sie bei Install/Update in die Skill-Verzeichnisse der Host-Tools
   (`hmem update-skills`, läuft auch als postinstall) — Skills sind damit
   unabhängig vom Memory versioniert und updaten sich mit dem Paket. D
   plant Skills bereits via `tim init`; das Sync-on-Update-Muster von hmem
   übernehmen, sonst driften installierte Skills von der Paket-Version weg.
4. **Multi-Host-Installer.** `hmem init` erkennt Claude Code, Gemini CLI,
   Cursor, Windsurf, Cline und OpenCode und konfiguriert MCP + Hooks pro
   Host. TIMs Zero-Config (D) zielt bisher implizit nur auf Claude Code —
   für „installieren und weiterarbeiten" als Produkt (E) muss der
   Bootstrap dieselbe Host-Breite haben.
5. **Checkpoint-Kadenz.** hmem zählt Exchanges pro Projekt und feuert alle
   N Exchanges einen Background-Checkpoint plus eine dezente Erinnerung im
   UserPromptSubmit-Hook (Zähler auch in der Statusline sichtbar). TIM
   checkpointet, aber ohne Kadenz-Zähler. Kleiner Baustein für D-Hooks.
6. **Token-Budget in Stats.** `hmem stats` schätzt Tokens pro Projekt und
   flaggt Überschreitung einer Schwelle (Briefing wird zu fett). Als
   Erweiterung von `tim_stats` — hilft, das Briefing-Budget aus D
   messbar zu halten.

**Bewusst NICHT übernehmen** (in TIM bereits besser gelöst oder absichtlich
ersetzt): 5-Level-Hierarchie (→ Hypergraph + depth), Curate-Server als
zweiter MCP-Server (→ tim_update_many/tag-Tools/doctor/health im einen
Server), `flush_context` (→ tim_checkpoint), Company-Memory als zweite
Datei (→ E Tier 3 mit Tenants), `find_related` per Tag-Overlap (→ A
Graph-Boost), Export/Import-Staging (existiert als tim_export/import),
AGENT_SETUP.md (→ tim-capabilities.md, eine Quelle).

## Reihenfolge & Abgrenzung

Empfohlen: erst Plan 5+6 fertig (Fundament), dann **A → B → C/D parallel → E**.
D2 (PromptSubmit-Hook) braucht A; C braucht 6; E-Tier-1 braucht nur 6,
E-Tier-2 braucht 5+C. Die F-Punkte (hmem-Erbe) sind klein und laufen als
Teil von D mit (F1 User-Model auch als Baustein des due-reminders-Plans);
F4 (Multi-Host) ist Voraussetzung für E als Produkt.

Non-Goals von Plan 12: eigene Vektor-DB, eigenes Embedding-Modell trainieren,
Kalender-/Drittsystem-Sync, Tool-Surface-Wachstum (Ziel: +0 bis +1 Tool —
Retrieval verbessert vorhandene Tools statt neue zu addieren), Web-UI (kommt
frühestens mit E-Tier-2).

## Offene Entscheidungen (Benni)

1. Embedding-Backend v1: lokal (ONNX, langsamer/gratis/privat) vs. API-Opt-in
   (besser/kostet/Klartext verlässt Gerät)? Vorschlag: lokal default,
   API-Opt-in per Config — Secret-Nodes IMMER lokal.
2. Secret-Default für neue Projekte: opt-in (default klartext, Server-Features
   funktionieren) oder opt-out (default secret, privacy-first)? Vorschlag:
   opt-in pro Subtree, aber `tim init` fragt einmal.
3. Benchmark-Ambition: nur eigener Golden-Query-Harness oder echte
   LongMemEval-Teilnahme (mehr Aufwand, aber zitierbares Ergebnis)?
4. Auto-Projekt-Anlage wirklich ganz ohne Rückfrage? (Vorschlag: ja —
   reversibel via `irrelevant`; Alternative wäre eine einmalige
   Bestätigungszeile im ersten Briefing.)
5. Update-Check default an (mit Opt-out) oder default aus? (Vorschlag: an —
   aber im Briefing sichtbar machen, DASS gecheckt wird.)
