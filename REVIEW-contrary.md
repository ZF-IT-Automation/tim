# TIM Contrary Review — Der Fall gegen das Projekt

> Erstellt 2026-07-07 auf HEAD `656c134`. Auftrag: bewusstes Contrarian-Review — nicht
> "was ist kaputt" (das leistet `REVIEW-fable5.md`), sondern der stärkste ehrliche Fall
> **gegen** Prämissen, Richtung und Ressourceneinsatz des Projekts. Advocatus Diaboli,
> aber evidenzbasiert: jede Behauptung ist gegen Repo-Stand, Git-Historie oder die
> eigenen Docs geprüft. Am Ende steht, wo dieser Fall selbst am schwächsten ist.

## These

TIM ist ein technisch zunehmend solides System, das drei Fragen konsequent nicht
beantwortet, die vor jeder weiteren Zeile Code beantwortet gehören:

1. **Macht TIM einen Agenten messbar besser als eine gepflegte `CLAUDE.md` plus grep?**
   Niemand hat es gemessen. Es gibt einen Retrieval-Benchmark — der misst Retrieval
   gegen ein selbstgebautes Golden-Set, nicht Task-Outcomes.
2. **Für wen außer den Autor?** N=1 User, N=1 Agent-Stack, N=1 ernsthaft genutztes
   Projekt — und dieses Projekt ist TIM selbst.
3. **Warum wächst die Oberfläche schneller als der Beweis?** 42 MCP-Tools, 11 Node-Types,
   E2E-Krypto-Roadmap mit Per-Node-Key-Rotation und Bezahldienst-Plänen — bevor Frage 1
   auch nur einmal gestellt wurde.

Die Einzelargumente:

---

## 1. Das Wirksamkeits-Loch: Das Produktversprechen wurde nie getestet

Das Vision-Paper verspricht: *"Agent erinnert sich — User wiederholt nichts."* Das ist
eine empirische Behauptung über Agent-Verhalten, und sie ist nach 139 Commits, ~19k
Zeilen Source und ~17k Zeilen Tests **ungeprüft**.

Was stattdessen existiert: ein Retrieval-Benchmark (precision@3, recall@5, MRR) mit
einer Golden-Query-Suite, die im eigenen Test lebt (`docs/retrieval-benchmark.md`).
Das misst, ob TIM findet, was TIM indexiert hat — Zirkelschluss. Die relevante Messung
wäre: dieselbe reale Aufgabe, derselbe Agent, TIM an vs. TIM aus (Baseline:
`CLAUDE.md` + `git log` + grep), Metrik: Turns bis Lösung, Wiederholungsfragen,
Fehlentscheidungen durch veralteten Kontext. Diese Messung kostet einen Nachmittag.
Sie wurde durch drei Phasen Roadmap, zwölf Implementierungspläne und drei
Review-Dokumente hindurch nicht gemacht.

Die Nullhypothese ist unbequem stark: Harnesses laden `CLAUDE.md` gratis, ohne
42 Tool-Descriptions, ohne Summarizer-Pipeline, ohne Marker-Datei mit fünf
ungelockten Writern. Solange der A/B-Vergleich fehlt, ist jede weitere
Feature-Investition eine Wette auf eine ungetestete Prämisse.

## 2. Die Selbstreferenz-Falle: TIMs einziger ernsthafter Inhalt ist TIM

P0063 — das TIM-Projekt — ist das mit Abstand am intensivsten gepflegte Projekt in
der Datenbank. Die Sessions, die TIM loggt, sind TIM-Entwicklungssessions. Die
Lessons, die TIM speichert, sind Lessons über TIM. Das System hat seinen Wert nie
an Arbeit bewiesen, die nicht es selbst ist.

Das ist nicht nur ästhetisch unschön, es verzerrt systematisch das Produktdesign:
Ein Memory-System, dessen Inhalt Memory-System-Entwicklung ist, optimiert für
genau diese Inhaltsform (Pläne, Bugs, Architektur-Entscheidungen, Batch-Summaries
über Coding-Sessions). Ob die Abstraktionen — 11 Node-Types, Tree-Templates,
Sections-Schema — für ein zweites, andersartiges Projekt tragen, ist unbekannt.
Dogfooding ist gut; Dogfooding als *einzige* Evidenzquelle ist ein geschlossener
Kreislauf.

Dazu die Meta-Arbeits-Quote: 12 Plan-Dokumente (~6.500 Zeilen) in fünf Tagen
(2.–7. Juli), drei Review-Dokumente im Repo-Root, ein Review über Reviews
(`REVIEW-plans-7-11.md`) — und dieses Dokument macht es zum vierten. Das Projekt
produziert Diskurs über sich selbst in einer Rate, die bei einem N=1-Tool durch
nichts gedeckt ist.

## 3. Tool-Ökonomie: TIM verbraucht das Gut, das es sparen soll

TIMs Existenzbegründung ist Kontextfenster-Schonung. Gleichzeitig definiert
`tim-mcp/src/server.ts` **42 Tools** (Vision-Paper: "37" — die Oberfläche wächst
schneller als die eigene Spec). Selbst nach Internal-Hiding sieht der Agent ~30
Tools, deren Descriptions in **jeder Session jedes Projekts** Prompt-Tokens kosten —
dauerhaft, unabhängig davon, ob das Tool je aufgerufen wird.

Die Nutzungsrealität laut eigenen Skills und Docs: `tim_load_project`, `tim_write`,
`tim_search`, Session-Logging. Der lange Rest ist spekulative Oberfläche, teils
dokumentiert kaputt: `tim_lease` per MCP unbenutzbar (REVIEW-fable5, P1),
Suppression nur ¾ durchgesetzt, `tim_trace` ohne belegten Use-Case jenseits von
Demos. Dazu die Begriffslast des Datenmodells: Visibility-Bitmasken, Leases,
Negative Memory, Cold-Tiers, Sharding-Pläne — Konzepte für Multi-Agent- und
Multi-User-Szenarien, die es nicht gibt.

Jedes dieser Konzepte wäre einzeln verteidigbar. In Summe ist es ein System, dessen
Interface-Komplexität die eines Werkzeugs für ein 50-Personen-Team hat, betrieben
von einer Person, die dem Agenten beibringen muss, es zu ignorieren.

## 4. Plattform-Risiko: TIM baut in Shell-Skripten nach, was Harnesses nativ shippen

Die Hook-Schicht (Session-Start-Detection, Exchange-Logging, detached Summarizer,
Marker-Datei, Lock-TTLs) repliziert Funktionalität, die Harness-Anbieter nativ
bauen: Auto-Compaction, native Memory-Features, `CLAUDE.md`-Injection,
Session-Persistenz. TIM konkurriert hier nicht mit einem schwachen Gegner, sondern
mit den Plattformen selbst — auf deren instabilsten API-Oberfläche (Hook-Formate).

Die Kopplung ist bereits gerissen: Die Harness-Detection keyt auf ein Feld, das
Claude Code nie sendet, und funktioniert laut REVIEW-fable5 "only by accident".
Drei Komponenten implementieren drei verschiedene Marker-Discovery-Regeln. Das ist
kein Bug-Pech — es ist die strukturelle Konsequenz davon, eine Integrationsschicht
gegen bewegliche, undokumentierte Harness-Interna zu bauen. Jedes Harness-Update
ist ein potenzieller Totalausfall der Write-Pipeline, und der Ausfall ist per
Design leise (detached Prozesse, geschluckte Fehler, `|| true`).

## 5. Die Privacy-Story ist in sich widersprüchlich

Das Vision-Paper investiert seitenweise in E2E-Verschlüsselung: AES-256-GCM,
scrypt, Passphrase-Rotation, Per-Node-Keys, Keychain-Integration. Gleichzeitig:

- **Roh-Exchanges** — die sensibelsten Daten im System — gehen unverschlüsselt an
  Cloud-Summarizer (DeepSeek/OpenRouter in der Fallback-Chain; API-Key auf argv,
  sichtbar in `ps`, REVIEW-fable5 P2).
- **Embedding-Provider `type: api`** schickt Node-Inhalte an externe Dienste; das
  Paper selbst nennt es einen "Datenabfluss-Pfad" und lässt ihn trotzdem zu.
- **"Roh-Exchanges werden nie gelöscht"** wird als Feature verkauft. Es ist eine
  Haftung: Jeder in eine Session gepastete API-Key, jedes Kunden-Datum, jeder
  Fehltritt liegt permanent in `tim.db` — und soll per Sync auf einen Bezahserver
  repliziert werden. Es gibt kein Redaktions-Tool, keinen Secret-Scan im
  Write-Pfad, kein Vergessen. Die 7 Guard-Muster filtern Noise, nicht Geheimnisse.

Ein System, das die Datenbank E2E-verschlüsselt, während der Inhalt derselben
Datenbank auf dem Weg dorthin durch zwei unverschlüsselte Cloud-Pfade läuft,
optimiert die Krypto-Architektur am falschen Ende. Der Threat-Model-Abschnitt,
der das auflösen würde, existiert nicht.

## 6. LWW ist die falsche Konfliktsemantik für Wissen

Last-Write-Wins ist für Session-Logs vertretbar. Als Default-Mechanik eines
*Wissens*speichers bedeutet es: Bei konkurrierenden Schreibzugriffen wird eine der
beiden Wahrheiten kommentarlos verworfen. Das Paper erkennt das Problem (Rules und
Decisions sollen `manual` sein) — aber der `manual`-Pfad ist ungebaut, die
per-Node-Type-Strategie ungebaut, und `envelopeToStaging` verliert laut fable5
die Origin-Attribution, die für den LWW-Tiebreak gebraucht wird. Faktisch shippt
TIM heute: stilles Verwerfen von Wissen als einziges Konfliktverhalten, in einem
Produkt namens "Theoretically Infinite Memory".

## 7. Engineering-Hygiene widerspricht dem eigenen Anspruch

Für ein Projekt, dessen Verkaufsargument Verlässlichkeit von Gedächtnis ist,
toleriert das Repo bemerkenswerte Zustände:

- **`node_modules/` ist eingecheckt** — 4.818 Dateien im Git-Index, obwohl
  `.gitignore` es ausschließt (force-added). Dasselbe für **308 `dist/`-Dateien**
  (`JOURNAL.md` dokumentiert `git add -f` als "repo convention").
- Genau diese Committed-dist-Konvention hat den **P0 aus REVIEW-fable5** erzeugt
  (stale dist testete wochenlang alten Code und ließ `tim doctor` 7.381 Phantom-
  Orphans melden). Die dortige **Empfehlung #1 — Pretest-Build-Gate — ist vier
  Tage und ~60 Commits später weiterhin nicht umgesetzt**: `"test": "vitest run"`,
  kein `pretest`, in keinem Package.
- `JOURNAL.md` behandelt **4 dauerhaft rote Tests als akzeptierte "Baseline"**
  (Global-Marker leakt in die Test-Env). Ein Memory-System, dessen Testsuite von
  auf dem Entwicklerrechner liegenden Zustandsdateien abhängt, hat das
  Isolations-Problem, das es Usern lösen will, im eigenen CI nicht gelöst.

Einzeln Kleinkram. Zusammen ein Muster: Das Projekt verlangt von seinen Nutzern
Vertrauen in unsichtbare Hintergrund-Automatik, wendet aber auf die eigene
Infrastruktur einen laxeren Standard an, als es je einem Nutzer zumuten würde.

## 8. Prioritäten-Drift: Die Vision altert schneller, als sie gebaut wird

Das Vision-Paper (Stand 0.6) deklariert Breaking Changes für Phase 0.7: Sessions
als Root-Nodes (R7), CWD-only Discovery (R9), `tim-migrate` Rewrite (R18). Stand
heute: alle drei unerledigt. Stattdessen sind an der Queue vorbei gelandet:
Memory-Trust-Annotations, Write-Dedup, Usage-Feedback-Ranking, `tim_guard`,
`tim_delta`, Hybrid-Retrieval (12a), Konsolidierungs-Pipeline mit Curation-Queue
(12B) — Pläne 8 bis 12B, entstanden und gemerged innerhalb von fünf Tagen.

Das Muster: Neue, interessante Features schlagen alte, beschlossene
Strukturkorrekturen. Jede Woche, in der Sessions weiterhin Sub-Nodes sind und drei
Discovery-Regeln koexistieren, macht die Breaking Changes teurer — mehr Daten im
alten Layout, mehr Code auf den alten Pfaden. Ein Soll-Zustands-Paper, dessen
Kernentscheidungen von der Feature-Entwicklung dauerhaft überholt werden, ist kein
Plan, sondern ein Wunschzettel mit Versionsnummer.

## 9. Phase 0.8–1.0 ist ein Geschäftsplan im Hobby-Projekt

Die Roadmap enthält: TIM-Sync-Server auf Strato-VPS als "Bezahldienst geplant",
Per-Node-Sharing mit Recipient-Public-Key-Wrapping, Passphrase- und
Key-Rotations-Protokolle, npm-Publish, Brew/apt-Pakete, HN/Reddit-Launch. Das ist
Produkt-Infrastruktur für eine Nutzerbasis, die nicht existiert, entworfen bevor
die Kernthese (§1) validiert ist. Selbstgebaute E2E-Krypto mit Revocation-Semantik
ist eine der teuersten und fehlerträchtigsten Software-Gattungen überhaupt — sie
als Solo-Projekt-Phase zwischen "Embeddings" und "Doku schreiben" einzuplanen,
unterschätzt die Gattung um Größenordnungen. Der kontraintuitive, aber billigere
Weg wäre: Syncthing/Git/beliebiger E2E-File-Sync über die eine SQLite-Datei, und
die gesamte Phase 0.8 streichen, bis zahlende Nachfrage real ist.

---

## Wo dieser Fall am schwächsten ist

Ehrlichkeit gebietet die Gegenrechnung:

- **Der technische Kern ist gut gewählt.** SQLite + WAL + FTS5, local-first, eine
  Datei — das ist die richtige, langweilige Basis, und REVIEW-fable5 bestätigt,
  dass die jüngere Code-Qualität (zod-Registry, deterministisches LWW,
  Fehlerkontrakt) steigt, nicht sinkt.
- **Die Feedback-Schleifen existieren immerhin.** Ein Retrieval-Benchmark, eine
  Curation-Queue, Usage-Ranking, Kill-Switches per Env-Var — die meisten
  Memory-Projekte haben nichts davon. Der Vorwurf in §1 ist "falsch gemessen",
  nicht "nicht gemessen wollen".
- **N=1 ist bei Personal Tools kein Todesurteil.** Viele gute Werkzeuge begannen
  als Selbstbedarf. Der Vorwurf trägt nur, weil die Roadmap (Bezahldienst, Launch)
  explizit über N=1 hinauszielt — wer nur für sich baut, darf das alles.
- **Das Grill-me-Ritual (19 Runden, R1–R19) und die beauftragten Reviews** —
  inklusive dieses hier — zeigen eine Selbstkritik-Bereitschaft, die dem
  Kernrisiko "geschlossener Kreislauf" aktiv entgegenwirkt. Die Meta-Arbeit aus §2
  ist auch das Immunsystem des Projekts, nicht nur sein Overhead.

## Konsequenz, falls man diesen Review ernst nimmt

Nicht "alles wegwerfen" — sondern die Beweislast umdrehen:

1. **Das A/B-Experiment vor jedem weiteren Feature.** Fünf reale Aufgaben, TIM an
   vs. `CLAUDE.md`+grep, Turns/Wiederholungen/Fehlgriffe zählen. Ergebnis committen
   wie einen Test. Fällt es negativ aus, ist das die wertvollste Erkenntnis, die
   dieses Repo je produziert hat.
2. **Zweites echtes Projekt onboarden, das nicht TIM ist** — und die Abstraktionen
   an dessen Reibung messen, bevor Schemas/Types weiter wachsen.
3. **Tool-Diät: Oberfläche auf ~10 Tools schrumpfen**, Rest hinter ein einziges
   `tim_admin` oder in die CLI. Jede Description rechtfertigt sich gegen ihre
   Token-Kosten in jeder Session.
4. **Phase 0.8 streichen oder auf File-Sync-Basis degradieren.** Eigene
   E2E-Krypto-Protokolle erst bei nachgewiesener externer Nachfrage.
5. **Die zwei überfälligen Breaking Changes (R7, R9) vor jedem neuen Plan** — oder
   sie offiziell aus dem Vision-Paper streichen, damit Soll und Ist wieder dasselbe
   Dokument bewohnen.
6. **Hygiene-Schuld in einem Rutsch:** node_modules und dist aus dem Index,
   Pretest-Build-Gate, die 4 Baseline-Failures fixen statt tolerieren.
7. **Threat-Model-Dokument** für die Exchange-Pipeline (Cloud-Summarizer,
   Embeddings, Never-Delete) — vor dem nächsten Sync-Commit, nicht danach.

Der härteste Satz zuerst und zuletzt: **TIM hat bewiesen, dass es gebaut werden
kann. Es hat noch nicht versucht zu beweisen, dass es gebraucht wird.** Alles
andere in diesem Dokument ist Fußnote zu diesem Satz.
