# TIM: Projekt-, Code- und Feature-Review

Datum: 2026-09-09. Geprüfter Stand: `acb738b74bae37e18d817e44eb594e8fde140851`.

## Urteil

TIM adressiert ein reales Problem: Agenten verlieren zwischen Sessions nicht nur Gesprächsverlauf, sondern Entscheidungen, Begründungen, verworfene Ansätze und den aktuellen Arbeitsstand. Ein lokales, projektbezogenes und über verschiedene Agenten zugängliches Gedächtnis ist dafür eine sinnvolle Produktidee.

Die technische Basis ist substanziell. SQLite, explizite Projektbindung, strukturierte Erinnerungen, Session-Aufzeichnung, Summaries, MCP, Migration und Wiederherstellung bilden einen brauchbaren Kern. Die Implementierung ist deutlich weiter als der geladene Projektbrief mit seiner Angabe von 101 Tests vermuten lässt.

Der größte Engpass ist die Zuverlässigkeit der gesamten Erinnerungskette. TIM kann vorhandenes Wissen beim Abruf übersehen, Wichtiges aus dem Briefing verdrängen und in bestimmten Session-Verläufen neue Exchanges nicht automatisch zusammenfassen. Gleichzeitig wachsen Verwaltungsfunktionen und Betriebsaufwand. Meine Priorität wäre deshalb: zuerst nachweisbar besser erinnern, danach weitere Produktflächen ausbauen.

Als persönliches Werkzeug für langfristige Arbeit an mehreren Projekten hat TIM hohen Nutzen. Für gelegentliche Sessions an einem einzigen Repository muss es den Zusatzaufwand gegenüber einer gepflegten Projektdatei und einer guten Übergabenotiz erst rechtfertigen. Einen universellen Nutzen für alle Agenten-Nutzer belegt der aktuelle Testbestand nicht.

## Umfang und Evidenz

Dies ist ein Review des gesamten aktuellen Projekts mit vertieften Stichproben, kein Commit-Diff und kein vollständiges Sicherheitsaudit. Der Ausgangsbaum war sauber. Untersucht wurden die zehn Workspaces, Dokumentation, Session- und Suchpfade, Sync/Secrets, öffentliche Interfaces, Tests und Build-/Betriebsgrenzen. Ältere Reviews und TIM-Einträge wurden als Hinweise behandelt, nicht als Beweis für noch bestehende Fehler.

Die zwei getrennten Achsen des `code-review`-Skills wurden mit parallelen Teilreviews durchgeführt. Da der Auftrag das ganze Projekt betrifft, ersetzt der festgehaltene HEAD einen vom Benutzer vorgegebenen Diff-Bezugspunkt. Soll-Quellen waren `README.md`, `docs/tim-capabilities.md` und öffentliche Tool-Schemata. Ein eigenständiges Coding-Standards-Dokument wurde nicht gefunden; Architekturbeobachtungen sind daher Urteile, keine behaupteten Regelverstöße.

| Prüfung | Ergebnis |
|---|---|
| `npx vitest run` | 215 Testdateien bestanden; 1829 Tests bestanden, 2 übersprungen; 71,06 Sekunden |
| `npm run lint` | Bestanden; dieses Script ist TypeScript-Typprüfung, kein zusätzlicher Stil-Linter |
| `node scripts/check-build-output.mjs` | 151 Module vollständig; ausführbare Einstiegspunkte korrekt |
| Gezielte Gegenproben | Flüchtige In-Memory-Stores, synthetische Daten und sichere Shell-Ersatzfunktionen |
| Produktcode geändert | Nein |

Die übersprungenen Tests betreffen `falls_back_on_chain_timeout` und `handles_db_lock_during_verify` in `remember-handler.test.ts`. Cross-Package-Imports und CLI-Integrationstests verwenden vorhandenes `dist/`; es wurde kein frischer vollständiger Build durchgeführt. Build-Vollständigkeit beweist nicht die bytegenaue Übereinstimmung jedes Artefakts mit dem Quelltext. Die Befunde wurden zusätzlich im aktuellen Quelltext nachvollzogen; Teilreview-Gegenproben transpilierten betroffene Quellen im Speicher.

Nicht geprüft wurden eine echte LLM-Summarizer-Kette, die Qualität eines realen Embedding-Modells, ein Live-Sync mit mehreren Geräten, Disaster Recovery im laufenden Betrieb und die aktuellen Konfigurationen sämtlicher Agenten-Hosts. Die produktive Datenbank wurde nicht direkt per SQL untersucht. Der Projektbrief wurde über TIM geladen und die Session gemäß Marker gebunden.

## Standards

Die folgenden zwei Befunde stammen aus der unabhängigen Architektur-/Standards-Prüfung. Die Reihenfolge innerhalb dieser Achse bleibt erhalten.

### S1 — P1: Remote-Löschungen verlieren ihre Konfliktversion

In [sync-methods.ts](../../packages/tim-store/src/sync-methods.ts#L121) setzt `applyRemoteEntry` bei einer Löschung nur `tombstoned_at`. Die nächste Konfliktprüfung verwendet weiterhin das alte `updated_at` und `lww_device`.

Die In-Memory-Gegenprobe gegen den aktuellen Quelltext ergab: Schreiben bei Zeitstempel 1000, Löschen bei 3000, verspätetes Update bei 2000. Das veraltete Update wird akzeptiert, stellt den Inhalt wieder her und entfernt die Tombstone-Markierung. Löschungen für noch unbekannte IDs werden ebenfalls verworfen. Offline-Geräte und vertauschte Zustellreihenfolgen können dadurch gelöschtes Wissen wiederherstellen.

Löschungen müssen ihren Zeitstempel und ihr Gerät behalten; auch für noch unbekannte IDs braucht es eine dauerhafte Löschversion. Zusätzlich gibt es einen zweiten Replikationspfad in [store.ts](../../packages/tim-store/src/store.ts#L2925), der physisch löscht. Diese duplizierte Konfliktlogik sollte zusammengeführt werden. Das ist ein konkreter Fall von möglicher „Duplicated Code“, nicht bloß eine Stilpräferenz.

### S2 — P1: Normale Sync-Aufrufe umgehen die zusätzliche Secret-Verschlüsselung

[sync.ts](../../packages/tim-sync-client/src/sync.ts#L177) lässt Secret-Payloads unverändert, wenn `secretEncrypt` fehlt. Die normalen Aufrufer in [sync-cli.ts](../../packages/tim-cli/src/sync-cli.ts#L137) und [auto-sync.ts](../../packages/tim-sync-client/src/auto-sync.ts#L43) übergeben keine `secretPassphrase`.

Eine Gegenprobe gegen die Transformation des aktuellen Quelltexts bestätigte: Ein Eintrag mit `metadata.secret=true` behält Titel und Inhalt und erhält keine `is_encrypted`-Markierung. Die äußere AES-Verschlüsselung bleibt vorhanden. Der Fehler betrifft die zusätzliche Geheimhaltungsgrenze gegenüber Geräten oder Personen, die bereits die normale Sync-Passphrase besitzen.

Die Secret-Passphrase muss durch die unterstützten Einstiegspunkte gereicht werden. Fehlt sie, darf TIM als geheim markierte Inhalte nicht stillschweigend ohne die zusätzliche Schutzschicht veröffentlichen.

**Achsenbilanz:** Zwei funktionale Befunde mit Priorität P1; schwerste Folgen innerhalb dieser Achse sind die Wiederherstellung gelöschter Inhalte und die umgangene Secret-Grenze. Keine separat belegten Verstöße gegen dokumentierte Coding-Standards.

## Spec

Die folgenden drei Befunde stammen aus der unabhängigen Soll-Prüfung. Die Reihenfolge innerhalb dieser Achse bleibt erhalten.

### P1 — P1: Summarizer-Start behandelt Dateipfade als Shell-Code

Soll: „Unsummarized Batches erkennen → Summarizer spawnen“ in [tim-capabilities.md](../tim-capabilities.md#L230).

[session-hooks.ts](../../packages/tim-hooks/src/session-hooks.ts#L69) verwendet `JSON.stringify` als Shell-Quoting und setzt einen ungeschützten Pfad in den EXIT-Trap ein. Bei `/tmp/review space/lock` erhält `rm` die Argumente `-f`, `/tmp/review`, `space/lock`. Der gewünschte Lock bleibt liegen; andere zu den getrennten Pfaden passende Dateien können gelöscht werden. Dollar- und Backtick-Ausdrücke bleiben ebenfalls ausführbar.

Die Gegenprobe ersetzte `rm` und `timeout` durch harmlose Shell-Funktionen; es wurden keine Dateien gelöscht. Abhilfe: Prozesse mit Argumentarrays starten und Locks über Dateisystem-APIs entfernen. Falls die Shell bleibt, müssen beide Auswertungsebenen korrekt geschützt werden.

### P2 — P2: Fortgesetzte Teilbatches werden beim Idle-Sweep übersehen

Soll: „Unsummarized Batches erkennen“ in [tim-capabilities.md](../tim-capabilities.md#L230).

[session-hooks.ts](../../packages/tim-hooks/src/session-hooks.ts#L293) berechnet offene Exchanges als `exchangeCount - batchesSummarized * batchSize`. Das setzt voraus, dass jede Summary einen vollständigen Batch abdeckt.

Gegenprobe: Batchgröße 5, eine Summary für Exchanges 1–2, danach Fortsetzung mit Exchanges 3–4. Die Zähler sind 4 und 1; die Rechnung ergibt −1. Der Idle-Sweep gibt `[]` zurück, obwohl zwei Exchanges unzusammengefasst sind. [session.ts](../../packages/tim-store/src/session.ts#L552) kennt die tatsächliche Abdeckung, wird von diesem Gate aber nicht erreicht. Die automatische Nachverarbeitung muss auf abgedeckten Sequenzbereichen beruhen.

### P3 — P2: Section-Reads verletzen den Summary-first-Vertrag

Soll: „Voller Inhalt nur mit `include_body=true`“ in [tim-capabilities.md](../tim-capabilities.md#L201) und im öffentlichen Read-Schema.

Der Section-Zweig in [server.ts](../../packages/tim-mcp/src/server.ts#L2165) liefert rohe Section- und Kind-Einträge zurück. Er umgeht `summarizeEntry`, gibt trotz `include_body:false` vollständige Inhalte aus und liefert Kinder auch bei `includeChildren:false`. Große Sections können so das Kontextfenster stark belasten. Außerdem fehlen dort die Trust-Anreicherung und Read-Telemetrie der anderen Read-Zweige. Der Befund beruht auf dem direkten Codepfad; kein Live-Read großer produktiver Sections wurde ausgeführt.

**Achsenbilanz:** Drei Soll-Abweichungen; höchste Priorität innerhalb dieser Achse hat die Shell-Auswertung beim Summarizer-Start.

## Ergänzende Befunde des Hauptreviews

### R1 — P2: Semantische Suche kann keine rein semantischen Treffer entdecken

[store.ts](../../packages/tim-store/src/store.ts#L2412) erzeugt für alle Suchmodi zunächst ausschließlich FTS-Kandidaten. Embeddings werden danach nur zur Neusortierung dieser Kandidaten verwendet. Ohne FTS-Treffer wird nicht einmal der Query-Vektor berechnet.

Gegenprobe: Eintrag „Automobile maintenance procedure“ mit gespeichertem Vektor; Anfrage „vehicle servicing“. Sowohl `vector` als auch `hybrid` liefern null Treffer. Diese Gegenprobe prüft die fehlende Kandidatenroute, nicht die Qualität eines realen Modells. Unabhängig von dessen Qualität kann der vorhandene Algorithmus den Eintrag nicht erreichen.

FTS und Vektorsuche brauchen unabhängige Kandidatenmengen, die anschließend zusammengeführt werden. Der aktuelle Hybrid-Abschnitt der Dokumentation beschreibt FTS als Kandidatengenerator korrekt; der öffentliche Modus `vector` und die weitergehende semantische Vision werden damit aber nicht eingelöst.

### R2 — P2: Der öffentliche Suchmodus wird ignoriert

Das Schema akzeptiert `searchType: 'fts' | 'vector' | 'hybrid'`. [server.ts](../../packages/tim-mcp/src/server.ts#L2318) reicht diesen Parameter nicht an `s.search` weiter. Deshalb landet auch eine explizite FTS-Anfrage im Hybrid-Default des Stores. Nutzer können die Rechenkosten und das Verhalten nicht verlässlich über den zugesagten Parameter steuern. Dies ist im aktuellen Quelltext direkt nachvollziehbar; es wurde keine gesonderte MCP-Gegenprobe ausgeführt.

### R3 — P2: Projektfilter greifen zu spät

[prompt-submit.ts](../../packages/tim-hooks/src/prompt-submit.ts#L47) sucht zunächst global neun Treffer und filtert erst danach auf das Projekt. Andere Projekte können alle neun Plätze belegen.

Gegenprobe: ein passender längerer Eintrag in P0001, zwölf höher gerankte kurze Treffer in P0002. `searchFts(..., {project:'P0001'})` findet den Eintrag; `runPromptSubmit(..., projectLabel:'P0001')` liefert `null`. Damit verschlechtert zusätzliches Wissen in fremden Projekten die Erinnerung an das aktuelle Projekt.

Der MCP-Suchpfad hat dasselbe strukturelle Problem mit einem größeren globalen Limit von 1000. Auch Typ-/Statusfilter werden nachträglich angewendet. Filter sollten vor dem Kandidatenlimit greifen. Der Prompt-Hook übergibt zudem den gesamten Nutzertext an eine implizite AND-Suche; lange natürliche Fragen stellen dadurch unnötig strenge Trefferbedingungen. Die AND-Semantik ist in der [SQLite-FTS5-Dokumentation](https://www.sqlite.org/fts5.html#fts5_boolean_operators) beschrieben.

### R4 — P2: Das Briefing-Budget kann offene Aufgaben vollständig verdrängen

Laut Soll sollen offene Aufgaben beim Kürzen Priorität erhalten. [store.ts](../../packages/tim-store/src/store.ts#L691) lädt den Baum jedoch tiefenorientiert nach Strukturreihenfolge bis zum globalen Limit. Eine frühe große Section kann das Budget verbrauchen, bevor Tasks oder Sessions erreicht werden. Spätere Sortierung im Renderer kann bereits fehlende Einträge nicht zurückholen.

Gegenprobe: frühe Log-Section mit 201 Kindern, nachfolgende Tasks-Section mit einer offenen kritischen Aufgabe. Ergebnis beim Standardbudget: 200 Kinder, `truncated:true`, kritische Aufgabe fehlt. Das erklärt nicht automatisch jede Auffälligkeit des geladenen Live-Briefs, belegt aber den Mechanismus.

Der Abruf braucht reservierte Anteile für Regeln, aktive Arbeit und letzte Übergabe, danach ein gemeinsames Restbudget. Zusätzlich sollte die tatsächliche Text-/Tokengröße begrenzt werden, nicht nur die Zahl der Knoten.

### R5 — P2: Embeddings werden nach Inhaltsänderungen nicht erneuert

[store.ts](../../packages/tim-store/src/store.ts#L3174) wählt für Embedding ausschließlich Einträge ohne Vektor. Der normale Update-Pfad invalidiert vorhandene Vektoren nicht.

Gegenprobe: Eintrag anlegen, Vektor setzen, Inhalt vollständig ändern, `getUnembedded` aufrufen. Der geänderte Eintrag wird nicht erneut eingeplant. Sein Suchsignal bleibt dem alten Inhalt zugeordnet. Ein Content-Hash oder eine Inhaltsrevision sollte die Gültigkeit eines Vektors bestimmen. Die Suche sollte außerdem nur kompatible Modellversionen vergleichen.

### R6 — P2: Dokumentation und gespeichertes Projektwissen driften auseinander

Der geladene Projektbrief nennt 101 Tests; aktuell bestanden 1829. `tim-capabilities.md` führt verschiedene Features zugleich als vorhanden und geplant, beispielsweise Hybrid Retrieval und Embeddings. Mehrere zentrale Verweise, darunter `tim-vision-paper.md` und `production-readiness.md`, fehlen im aktuellen Checkout. `README.md` beschreibt `npm test` als Löschpfad für `dist/`, obwohl die aktuelle Kette `pretest → build` kein `clean` enthält; `prepare` enthält es weiterhin.

Ein Teil der alten technischen Findings ist inzwischen behoben: Build-Ausgaben sind nicht mehr getrackt, die Vollständigkeitsprüfung erfasst 151 Module, und CI enthält einen eigenen Build-Pipeline-Job. Die Aussagen des Reviews vom 2026-09-04 dürfen daher nicht pauschal als aktueller Zustand übernommen werden.

Für ein Gedächtnissystem ist diese Drift besonders relevant. Automatisch ermittelbare Angaben sollten aus Code und Diagnostik kommen. Gespeicherte Aussagen brauchen Quelle, Gültigkeitsbereich und Prüfzeitpunkt; alte Befunde sollten als historisch sichtbar bleiben, ohne aktuelle Briefings zu dominieren.

## Architektur und Entwicklungsqualität

Positiv sind die sinnvolle Paketgliederung, die lokal nutzbare SQLite-Basis, explizite Projektbindung, umfangreiche Tests für schwierige Randfälle, der inzwischen explizite Migrationspfad, konservative Curation-Vorschläge und konkrete Betriebswerkzeuge. Ein zentral definiertes Projektschema mit geprüftem Dokumentationsspiegel ist ein gutes Muster, das auch für andere Metadatenverträge geeignet wäre.

Die Paketgrenzen verhindern jedoch noch nicht die Konzentration vieler Verantwortungen: `store.ts` hat 3925 Zeilen, der MCP-Server 3715 und der CLI-Einstieg 1365. Die Länge allein ist kein Defekt. Relevant sind die sichtbaren Folgen: parallele Replikationspfade, unterschiedliche Read-Verträge, nachträgliche Suchfilter und wiederholte Projektauswertung. Ein eigener Retrieval-Dienst, ein gemeinsamer Read-/Briefing-Renderer und eine einzige Replikationslogik würden mehrere konkrete Fehlerklassen zusammen adressieren.

`TimStore` führt beim Öffnen weiterhin schreibende Wartung und Trigger-Erzeugung aus. Der Viewer umgeht ihn deshalb mit einem eigenen Read-only-Zugriff und spiegelt Teile der Abfragen. Ein expliziter Read-only-Store wäre eine sinnvolle Modulgrenze; er sollte keine Migrationen, Telemetrie oder Wartung auslösen.

Die Nutzung des Entwicklungscheckouts als laufende Installation bleibt ein Betriebsrisiko, selbst nachdem das halb getrackte `dist/` bereinigt wurde. Gebaute, versionierte Installationsverzeichnisse mit atomarem Umschalten wären belastbarer. Watchdogs und Reparaturscripte sind nützlich, ersetzen diese Trennung aber nicht.

## Nutzen der einzelnen Feature-Gruppen

Die Bewertung bezieht sich auf TIMs Zielgruppe: Personen, die über längere Zeit mit Agenten an mehreren Projekten arbeiten. „Hoch“ beschreibt den potenziellen Nutzen, nicht automatisch den aktuellen Reifegrad.

| Feature | Nutzen | Urteil und sinnvoller nächster Schritt |
|---|---|---|
| Lokaler SQLite-Store | Sehr hoch | Starke Basis für Eigentum, Offline-Arbeit und einfache Sicherung. Beibehalten. |
| Projektbindung und Marker | Sehr hoch | Verhindern Arbeit im falschen Kontext. IDs und Bindung müssen über Sessions und Geräte eindeutig bleiben. |
| Strukturierter Projektbaum | Hoch | Gut für Navigation und Briefings. Weniger Pflichtstruktur, mehr bedarfsgerechte Sections; leere Handbuchgerüste bringen wenig. |
| Entscheidungen, Regeln, Learnings | Sehr hoch | Wertvoller als reine Chat-Archivierung, weil Begründungen sonst verloren gehen. Quellen und Gültigkeit stärken. |
| Rohe Exchanges | Hoch | Grundlage für Nachprüfbarkeit und erneute Zusammenfassung. Aufbewahrung und explizites Löschen müssen steuerbar sein. |
| Automatische Session-Hooks | Sehr hoch | Machen Erinnerung alltagstauglich. Fehlende Aufzeichnung muss sichtbar sein; Adapter vertraglich testen. |
| Batch-Summaries und Rollups | Sehr hoch | Machen lange Historie nutzbar. Abdeckung, belegte Aussagen, Korrekturen und Wiederholbarkeit sind entscheidend. |
| Session-Resume, Topic-Resume, Handoff | Sehr hoch | Einer der stärksten konkreten Anwendungsfälle. Letzte Absicht, Stand, Ergebnis und offene Fragen priorisieren. |
| Projektbriefing und Delta | Sehr hoch | Spart Einstiegskosten. Relevanz und garantierte Kerninhalte zählen mehr als eine große Knotenzahl. |
| FTS-Suche | Sehr hoch | Schnell und transparent bei Namen und exakten Begriffen. Projektfilter und natürliche Suchfragen verbessern. |
| Hybrid-/Vektorsuche | Hoch | Nötig für Synonyme und anders formulierte Erinnerungen. Erst unabhängige Kandidatenroute und Index-Aktualität liefern. |
| `tim_remember` mit LLM-Reranking | Mittel bis hoch | Sinnvoll als ausdrücklich teurere zweite Stufe bei vagen Fragen. Ein Reranker kann fehlende Kandidaten nicht retten. |
| Promptbezogene automatische Erinnerung | Hoch | Kann relevante Information ohne Zusatzaufruf liefern. Heute durch Volltext-AND und späte Projektfilter begrenzt; braucht Präzisionsmessung. |
| Negative Memory / `tim_guard` | Hoch | Verhindert wiederholte bekannte Fehler. Kein Treffer darf nie als Sicherheitsnachweis interpretiert werden. |
| Staleness, Verifikation, Git-Provenance | Sehr hoch | Zentrale Differenzierung gegenüber einem Notizarchiv. Alter und „Commits seitdem“ sind nur Annäherungen an sachliche Gültigkeit. |
| Usage-basiertes Ranking | Mittel | Referenzen sind ein nützliches, aber verzerrtes Signal. Häufig genutzt bedeutet nicht korrekt; explizite Korrekturen höher gewichten. |
| Tags | Hoch | Günstiges Themenvokabular. Aliase vereinheitlichen; Status und Struktur weiterhin aus Metadaten ableiten. |
| Explizite Graph-Beziehungen | Mittel bis hoch | Wertvoll für „ersetzt“, „widerspricht“ und „begründet“. Generische Ähnlichkeitskanten rechtfertigen wenig manuelle Pflege. |
| Related-on-read | Hoch, wenn präzise | Wenige begründete Nachbarn können weitere Suchaufrufe sparen. Als gezielte Erweiterung behandeln; die dokumentierte umfassende Automatik ist nicht vollständig eingelöst. |
| Tasks, Bugs, Ideen und Statushistorie | Hoch für Arbeitskontinuität | Sinnvoll als Erinnerung an offene Arbeit. Vollständiges Ticketmanagement sollte optional bleiben oder externe Tracker referenzieren. |
| Commit-Aufzeichnung | Mittel bis hoch | Verbindet Absicht mit überprüfbarer Änderung. Hash, betroffene Pfade und Bezug reichen oft; Git-Historie nicht vollständig duplizieren. |
| Dedup, Suppression, Curation, Decay | Mittel bis hoch | Bekämpfen Rauschen. Vorschläge, Gründe und Rücknahme sind wichtiger als aggressive autonome Bereinigung. |
| Doctor, Viewer, Snapshots, Restore | Sehr hoch | Vertrauen entsteht durch Sichtbarkeit und Wiederherstellbarkeit. Den Viewer zum Erklären und Korrigieren nutzen. |
| CLI, MCP und Harness-Skills | Sehr hoch | Machen dieselbe Erinnerung überall erreichbar. Häufige Aufgaben sollten mit wenigen Aufrufen funktionieren; Skill-Text kann API-Lücken nicht dauerhaft kompensieren. |
| hmem-Import und Export | Hoch für bestehende Nutzer | Wichtig für Migration und Unabhängigkeit. Ein begrenzter, gepflegter Kompatibilitätsbereich ist sinnvoller als dauerhafter Dual-Stack. |
| Verschlüsselter Geräte-Sync | Hoch bei mehreren Geräten | Klarer Nutzen, aber erheblich höhere Korrektheitsanforderungen. Löschkonflikte und Secret-Grenzen zuerst schließen. |
| Hosted Sync und granulare Freigabe | Bedarfsabhängig | Erweitern das Produkt um Betrieb, Identität, Rechte und Widerruf. Separat priorisieren; dokumentierte Freigabevision nicht als fertig anbieten. |
| Codebase-Autopopulation | Mittel | Hilfreich als abgeleitete Karte mit Commit-Bezug. Erzeugte Dokumentation darf keine zweite, schnell veraltende Wahrheit werden. |
| Reminders, komplexe PM-Workflows, „Cognitive OS“ | Aktuell nachrangig | Nur aus konkretem Nutzungsbedarf ausbauen. Die Bezeichnung ist weiter als das bisher gemessene Leistungsversprechen. |

## Welche Erweiterungen TIM deutlich stärker machen würden

### 1. Ein überprüfbares Erinnerungsprotokoll

Jede abgeleitete Aussage sollte zu den konkreten Exchanges, Dokumenten oder Commits zurückführen. Dazu gehören Quellenrevision, Zeitpunkt und Ableitungsweg. Eine Erinnerung könnte dann erklären: „Diese Entscheidung stammt aus Session X, wurde durch Commit Y umgesetzt und später durch Z ersetzt.“

Ansätze existieren bereits in Provenance und Batch-Sequenzen. Die Erweiterung sollte sie durchgängig bis zur ausgegebenen Aussage verbinden. Das verbessert sowohl Agentenvertrauen als auch menschliche Fehlerdiagnose.

### 2. Gültigkeit und Widersprüche als Produktfunktion

„A war früher richtig, B gilt seit heute“ muss ausdrückbar sein, ohne A zu löschen. Dafür eignen sich Gültigkeitsintervalle und eine explizite Ersetzt-Beziehung. Neue widersprüchliche Aussagen sollten zunächst einen prüfbaren Konflikt erzeugen; eine Ähnlichkeitsheuristik sollte nicht eigenständig historische Wahrheit umschreiben.

Beim Retrieval hat der aktuelle gültige Stand Vorrang. Historische Fragen müssen trotzdem den damaligen Stand rekonstruieren können. Das wäre für Entscheidungen und Betriebswissen deutlich wertvoller als noch mehr generische Graph-Kanten.

### 3. Aufgabenbezogene Briefings mit festem Kontextbudget

Ein Einstieg in „Sync debuggen“ braucht andere Erinnerungen als ein Release oder eine Architekturdiskussion. Ein Briefing sollte die aktuelle Aufgabe, das Projekt und ein Tokenbudget berücksichtigen. Ein fester Kern enthält aktive Regeln, offene Arbeit und die letzte Übergabe; der Rest wird gezielt ergänzt.

Dies erweitert vorhandene Projekt-/Prompt-Briefings und behebt zugleich deren Kürzungsproblem. Ausgabe und Viewer sollten erklären, warum etwas enthalten oder weggelassen wurde.

### 4. Inhaltliche Gesundheitsanzeige für die Erinnerungskette

Ein laufender MCP-Prozess beweist nicht, dass Erinnerung funktioniert. Sinnvoll wären sichtbare Zustände wie: letzte aufgezeichnete Exchange, letzte abgedeckte Sequenz, letzter erfolgreicher Rollup, Embedding-Rückstand, Briefing-Kürzung und letzter erfolgreicher Sync.

Der Doctor hat bereits technische Gesundheitsdaten. Die Erweiterung sollte die gesamte Kette und ihre Lücken verständlich machen. Ein partieller oder fehlgeschlagener Schritt muss erneut ausführbar sein, ohne Handarbeit an Datenbankzeilen.

### 5. Ein echtes Qualitätslabor

Der vorhandene Benchmark-Harness ist ein guter Ausgangspunkt. Seine zwei kleinen Tests belegen aber nicht, dass TIM mehrwöchige Arbeit besser fortsetzt. Benötigt wird ein kuratierter Satz realistischer Fälle: deutsche und englische Fragen, Synonyme, korrigierte Entscheidungen, viele ähnliche Projekte, kurze fortgesetzte Sessions und lange verrauschte Historien.

Verglichen werden sollten mindestens: ohne zusätzliche Erinnerung, mit einer gepflegten Projekt-/Handoff-Datei und mit TIM. Zu messen sind erfolgreiche Aufgabenfortsetzung, richtige Quellen, übersehene relevante Einträge, falsche Erinnerungen, Tokenverbrauch, Latenz und Wartungsaufwand. Das kann mit überschaubar vielen festen Fällen beginnen; ein großer Datensatz ist keine Voraussetzung für den ersten belastbaren Vergleich.

### 6. Explizite Grenzen für fremdes und sensibles Wissen

Importierte Inhalte, Agentenvermutungen und vom Nutzer bestätigte Regeln benötigen unterscheidbare Herkunft und Autorität. Eine gespeicherte Handlungsanweisung darf nicht allein durch Wiederabruf zur verbindlichen Regel werden. Für Sharing kommen klare Berechtigungen und Widerruf hinzu.

Das ist keine Behauptung eines im Review demonstrierten Prompt-Injection-Angriffs. Es ist eine notwendige Gestaltung der geplanten Import-/Sharing-Flächen. Auch MCP behandelt Tool-Annotationen ausdrücklich als Vertrauenshinweise statt als belastbare Autorisierung; siehe [MCP: Tool Annotations as Risk Vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

## Empfohlene Reihenfolge

1. **Korrektheits- und Schutzlücken schließen:** Löschversionen im Sync, Secret-Schicht, Summarizer-Prozessstart. Danach konkrete Regressionstests für die gezeigten Ereignisfolgen.
2. **Erinnerungskette zuverlässig machen:** echte Batch-Abdeckung, Filter vor Limits, priorisiertes Briefing, konsistente Read-Verträge, Suchmodus durchreichen, Embeddings invalidieren und semantische Kandidaten unabhängig suchen.
3. **Nutzen messen und sichtbar machen:** Qualitätsfälle, Quellenbelege, Abdeckungsanzeige und aktueller Feature-/Betriebsstatus. Dokumentation und gespeicherten Projektbrief daraus aktualisieren.
4. **Auf dieser Grundlage erweitern:** temporale Gültigkeit, Widerspruchsbehandlung und aufgabenbezogene Briefings. Hosted Sharing, Reminder und umfangreichere Projektverwaltung erst nach nachgewiesenem Bedarf.

Diese Reihenfolge ist eine Produktempfehlung, keine Änderung am bestehenden Aufgabenbestand. Es wurden keine Implementierungen, Deployments oder Bereinigungen vorgenommen.
