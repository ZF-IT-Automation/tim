# TIM: Review zu Wirkung und Potenzial

Datum: 2026-10-03. Stand: `a7d9705` (master). DB-Snapshot von `~/.tim/tim.db`, per `.backup` gezogen um 12:55 MESZ.

Frage: Wie groß ist das Potenzial von TIM, und wie stark verbessert es bestehende LLMs und Coding-Agents?

## Urteil

**TIM macht Agenten nicht klüger. Es liefert ihnen aber Wissen, das ohne Memory schlicht fehlt.** Gemeint sind Begründungen von Entscheidungen, verworfene Wege und der aktuelle Stand von Workstreams. Den Code und die Doku liest ein Agent auch ohne TIM ebenso gut.

Im blinden A/B-Test erreichte „Repo + TIM“ 28 von 30 Punkten, „nur Repo“ 20 von 30. Der Test umfasste 10 Fragen eines zurückkehrenden Entwicklers zum Projekt TIM selbst. Der Vorsprung entsteht allerdings fast vollständig bei Fragen, deren Antwort konstruktionsbedingt nur in TIM steht. Bei den 6 Fragen, die auch aus dem Repo beantwortbar sind, steht es Repo+TIM 17, nur Repo 16. Einen Vergleich gegen Host-Memory wie Claude Code Auto-Memory oder eine einfache Progress-Datei gab es nicht.

**Auf die Erfolgsrate echter Coding-Tasks ist ein moderater Effekt zu erwarten, kein Sprung.** Die veröffentlichten Belege liegen meist im einstelligen Prozentpunktbereich. Zweistellige Effekte gibt es bei Aufgaben, die Wissen aus früheren Sessions zwingend brauchen (DreamBench-SWE, genau TIMs Nische), oder bei anderen Mechanismen wie Skill-Lernen (Letta):

| Quelle | Effekt |
|---|---|
| GitHub Copilot Memory | +7 pp PR-Merge-Rate |
| Subtask-Memory | +4,7 pp auf SWE-bench Verified |
| Letta Skills (Skill-Lernen, anderer Mechanismus) | +15,7 pp auf Terminal-Bench |
| DreamBench-SWE (Aufgaben brauchen frühere Sessions) | 11,7 % → 45–54 % |

Für den Autor ist der Nutzen real. Er arbeitet über viele Sessions und mehrere Hosts hinweg, mit Claude Code, Codex, Cursor und Hermes.

**Als persönliche bzw. Team-Infrastruktur ist das Potenzial hoch. Als Produkt für einen breiten Markt ist es im aktuellen Zustand gering.** Die Nische „cross-host, lokal, hook-basiert“ ist gegenüber den Hosts offen. Sie ist aber dicht besetzt mit Open-Source-Projekten, die eine sehr ähnliche Architektur haben und sich mit einem Befehl installieren lassen:

| Projekt | GitHub-Stars |
|---|---|
| claude-mem | ~95k |
| agentmemory | ~29k |
| beads | ~28k |
| engram | ~7k |
| TIM | 1 |

TIM hat außerdem keine Lizenz, und das letzte npm-Release stammt vom Juli.

**Größter Hebel:** Rauschen und Kosten senken und den Effekt auf echten Tasks messen, statt weitere Fläche zu bauen. Die bestehenden Kernpfade (Briefing, Handoff, Task-Tracking) tragen. Peripherie wie Sync, Temporal/Evidence und hmem-Altbestand wird kaum genutzt.

## 1. Blinder A/B-Test: Repo vs. Repo + TIM

Aufbau:

- **Fragen:** Ein Agent schrieb 10 Fragen mit Antwortschlüsseln. Wo möglich prüfte er die Schlüssel gegen Code und Git. Bei Q2, Q5 und teilweise Q4 und Q6 stammt der Schlüssel aus TIM selbst.
- **Zwei Arme:** Beide hatten Code, Git, `docs/`, CHANGELOG und LEDGER zur Verfügung. Der zweite Arm hatte zusätzlich die TIM-MCP-Tools. Das Budget lag bei ca. 40 Tool-Calls. Tatsächlich verbrauchte der Repo-Arm 40, der TIM-Arm 46.
- **Bewertung:** Ein Juror bewertete blind. Die Zuordnung A/B wechselte pro Frage, und Quellenangaben waren entfernt.
- **Kontrolle:** Das Transcript des Repo-Arms wurde geprüft. Es enthält keinen Zugriff auf TIM, sqlite, `~/.tim` oder `~/.claude`.

| # | Kategorie | Im Repo beantwortbar? | Repo | Repo+TIM | Bemerkung |
|---|---|---|---|---|---|
| Q1 | Warum FTS statt Embeddings | ja | 3 | 3 | Research-Doc reicht |
| Q2 | Warum kein Hermes-seitiges Opt-out | nein | 1 | 3 | Repo: „unbekannt“ |
| Q3 | Stale-Regel für Tasks | ja | 3 | 3 | |
| Q4 | Disk-voll-Incident September | ja (teilweise) | 1 ✗ | 3 | Repo-Arm übernahm den falschen Hergang aus `docs/cron.md`, mit Konfidenz 0,8. Commit 61c922f hätte es richtig gesagt. Recovery-Details stehen nur in TIM |
| Q5 | Englisch-Memory-Experiment | nein | 0 | 3 | nur in TIM |
| Q6 | Stand Sync / nächster Schritt | nein | 1 ✗ | 2 | Repo nennt den geparkten Schritt T05 als nächsten |
| Q7 | Session-ID-Duplikate erledigt? | nein | 2 | 3 | Dass OpenCode noch offen ist, steht nur in TIM |
| Q8 | Wo sind `tim_session_log`/`tim_checkpoint`? | ja | 3 | 3 | |
| Q9 | Symlink-Bug noch relevant? (Falle) | ja | 3 | 3 | TIM-Bug-Knoten veraltet |
| Q10 | `dist` committen? Deploy-Pfad (Falle) | ja | 3 | 2 | TIM-Log-Eintrag veraltet |
| | **Summe** | | **20/30** | **28/30** | Bei Repo-Fragen: Repo+TIM 17, nur Repo 16. Falsche Aussagen: 2 (nur Repo) vs. 0 (Repo+TIM) |

Einordnung:

- **Wo TIM wirkt:** Auf den 4 Fragen ohne Antwort im Repo holt TIM +7 Punkte. Das ist erwartbar, denn genau dafür existiert es.
- **Wo TIM nicht wirkt:** Bei aus dem Repo beantwortbaren Fragen gibt es keinen messbaren Vorteil. Repo+TIM 17, nur Repo 16, und der eine Punkt hängt an TIM-exklusiven Details zu Q4.
- **Veraltetes Wissen gibt es auf beiden Seiten.** Ohne TIM übernahm der Agent in 2 von 10 Fällen veraltete oder falsche Repo-Doku. TIM war selbst in 3 von 10 Fällen veraltet (Q4, Q9, Q10). Robust war erst die Kombination: Der TIM-Arm hat gegen das Repo gegengeprüft.
- **Statistische Aussagekraft ist gering.** Der Vorzeichentest ergibt 5 Siege, 1 Niederlage und 4 Unentschieden, einseitig p ≈ 0,11.

Grenzen:

- **Kleine Stichprobe:** n=10.
- **Bestgepflegtes Projekt:** Getestet wurde TIMs eigenes Projekt. Es hält 33 % aller kuratierten Einträge.
- **Fragen aus TIM gezogen:** Der Fragensteller nutzte TIM als Quelle. 9 von 10 Fragen sind in TIM beantwortbar.
- **Kein Host-Memory-Baseline:** Der Repo-Arm hatte kein Auto-Memory, kein `--resume` und keine Progress-Datei.
- **Wissensabruf, kein Task-Erfolg:** Gemessen wurde, ob Fragen richtig beantwortet werden, nicht ob Aufgaben gelingen.

Lesart: Das Ergebnis ist eine **Obergrenze gegenüber „kein Memory“ auf einem gut gepflegten Projekt**. Es ist kein allgemeiner Effekt.

## 2. Reale Nutzung (Produktions-DB und Transcripts)

**Datenbestand**

| Kennzahl | Wert |
|---|---|
| Einträge gesamt | 16.721 |
| davon maschinell (Exchanges, Batches, Summaries, Commits) | 68 % |
| davon hmem-Altbestand | 25 % |
| davon kuratiert | **5,8 %** (969 Knoten, entspricht ca. 920 Items) |

**Explizites Lesen (`tim_read`/`tim_search`)**

| Kennzahl | Wert |
|---|---|
| Kuratiertes, nie explizit gelesen (Juli–September) | **52 %**, auch bei Items älter als 30 Tage noch 47 % |
| … nach Typ | Decisions ca. 80 %, Logs 76 %, Rules 88 %\*, Tasks 11 % |
| Belegte Wiederverwendung von Wissen (Decision/Log/Learning/Rule gelesen und danach zitiert, verlinkt oder geändert) | **27 Items in 16 Sessions in 3 Monaten**. Von 423 „referenced“-Reads sind 307 Task-/Bug-Statuspflege und 37 Wissen |

**Lesen vs. Schreiben pro Host** (ohne Bot-Läufe)

| Host | Lesen | Schreiben |
|---|---|---|
| Claude Code | 260 | 570 |
| Codex | 400 | 115 |
| Cursor | 287 | 234 |
| Hermes | 1.133 | 1.001 |

Claude Code schreibt also deutlich mehr als es liest. Wahrscheinliche Ursache sind die „alles in TIM loggen“-Regeln in CLAUDE.md.

**Passive Pfade (Briefing, Reminder)**

| Kennzahl | Wert |
|---|---|
| Session-Briefing ausgespielt | 178 von 178 Claude-Code-Sessions |
| Startdirektive befolgt | 68 % der interaktiven Sessions, 78 % bei ≥ 20 Tool-Calls |
| Reminder | auf 26 % der Prompts |
| … davon (Urteil eines einzelnen Bewerters) | ca. 33 % relevant, ca. 31 % veraltete Open-Item-Recalls |

**Capture und Summaries**

| Kennzahl | Wert |
|---|---|
| Erfasste substanzielle Claude-Code-Sessions (seit 16.08.) | 94 % |
| Zusammengefasste User-Turns | 96,3 % gesamt, September 89 %, Oktober 87 % |
| Bekannte Ausfälle | 6.–27.07. Capture-Ausfall (3 Wochen, unbemerkt); 21.08.–23.09. Fallback-Modell tot |

**Restliche Funktionen und Bestand**

| Kennzahl | Wert |
|---|---|
| `tim_remember` (LLM-Rerank) | 17 echte Aufrufe, 0 erfolgreiche Reranks (Infrastruktur defekt). Seit 11.09. ungenutzt |
| hmem-Altbestand | 4.200 Einträge, davon 5 % je gelesen |
| Temporal/Evidence | 0 kuratierte Einträge mit `temporal` (Feature seit 11.09.). Die 293 Evidence-Einträge sind alle maschinell |
| Anteil Infra-Projekte (TIM, PM, o9k, team-up) an kuratierten Items | 73 %. Produktprojekte wachsen: im September 37 % der neuen Items |
| Offene Arbeit | 30 Tasks (Median 39 Tage alt), 10 Bugs (Median 54 Tage), 40 Ideen (Median 89 Tage) |

\* Rules und offene Tasks stehen ohnehin in jedem Briefing. `entry_usage` misst nur `tim_read` und `tim_search`, also Exposition und nicht Nutzung. Briefings, Reminder und CLI-Reads tauchen dort nicht auf.

**Lesart.** TIM funktioniert als **Rekorder** (seit Mitte August weitgehend zuverlässig) und als **Task-Tracker**. Als **Wissensbasis, aus der Agenten aktiv schöpfen**, ist es schwach belegt. Decisions wirken eher wie eine Versicherung: Sie werden selten gezogen, liefern dann aber die entscheidende Antwort. Q2 im A/B-Test beruhte auf einer Decision vom 10.08.

Den größten Nutzen hat wahrscheinlich der passive Pfad, und der ist ungemessen. Qualitativ fällt auf: Nach `/clear` fasst die erste Antwort des Agenten den Stand und den nächsten Schritt korrekt zusammen. Keiner von 4 nachverfolgten veralteten Recalls führte zu einer falschen Aktion.

## 3. Kosten

| Posten | Wert |
|---|---|
| Immer an (Direktive, Skill-Liste, Tool-Namen, Reminder) | ca. 4,9 KB, also ca. 1,2k Tokens pro Session |
| TIM-Traffic pro interaktiver Session | Median ca. 11k Tokens, p90 ca. 41k. Das sind ca. 4,6 % des Endkontexts in Fremdprojekten und 6 % in TIM-Dev-Sessions |
| Davon vermeidbar | **ca. ⅓**: `tim_write`/`tim_update` geben den ganzen Eintrag als pretty-printed JSON zurück. Im Mittel ca. 23 KB pro Session, 36 % der TIM-Bytes |
| Hintergrund-Summarizer | ca. 38 `codex exec`-Calls pro Tag. Je Call ca. 19k Input-Tokens, davon ca. 11k konstante, gecachte Harness-Instruktionen, für ca. 470 Output-Tokens. Läuft über ChatGPT-Abo-Quota (`auth_mode=chatgpt`), kostet also kein Geld pro Token. TIMs eigene Eval weist nur ca. 1,2k Tokens pro Call aus, weil sie gecachten Input nicht zählt |
| Hook-Latenz | Start: Median 0,8 s, p90 1,7 s. Pro Prompt 0,25–0,35 s; mit Jev laut Code-Pfad geschätzt bis ca. 1,75 s (Timeout liegt bei 2 s) |
| Betrieb | 10 `tim-mcp`-Prozesse mit zusammen 1,1 GB RSS, jeder mit eigenem Idle-Sweep. 7 Cron-Jobs, davon 3 defekt oder dauerfeuernd und nur 3 dokumentiert. 54 MCP-Tools, 37 CLI-Befehle, ca. 47 Config-Keys, 31 `TIM_*`-Env-Variablen |
| Wartung | Seit 01.09.: 137 `fix`- vs. 56 `feat`-Commits. Der September war bewusst ein Härtungsmonat. Hotspots: Briefing, Summarizer, Sync |
| Eigene Zeit | Bei einem Ein-Nutzer-Werkzeug der dominante Kostenfaktor: 814 Commits in 5 Monaten. Tokens sind dagegen nachrangig |

## 4. Code und Architektur

**Stärken**

- **Tests und CI:** 2.392 Tests in 287 Dateien laufen grün (92 s). `tsc` ist pro Package fehlerfrei, CI ist grün.
- **Altbefunde behoben:** Fast alle P1- und High-Befunde der Reviews vom 04.09. und 09.09. sind mit gezielten Commits behoben, darunter Sync-Tombstones, Secret-Gate, argv-Spawn, Restore-Lock und `dist/` untracked.
- **Migrationen:** Das Framework ist transaktional und verweigert implizite Upgrades. Die Maintenance-Sicherheit ist schlüssig umgesetzt.
- **Retrieval:** Die Entscheidung für reines FTS5 ist gemessen und ehrlich dokumentiert.

**Schwächen**

- **God-Objects:** `TimStore` hat 4.605 Zeilen und 90 öffentliche Methoden. Der CallTool-Handler in `tim-mcp/src/server.ts` ist ein einziger `switch` mit 1.632 Zeilen und 54 Fällen.
- **Peripherie:** Mindestens 28 % des Codes sind Peripherie: Sync 4,8k Zeilen, hmem-Migration 2,4k, Viewer 2,0k, dazu Benchmarks, Jev und Temporal/Evidence.
- **DDL bei jedem Store-Open:** In [store.ts:402](../../packages/tim-store/src/store.ts:402) läuft `createTriggers` (DROP + CREATE TRIGGER) bei jedem schreibenden Open. Dadurch wird auch der eigentlich lesende Prompt-Hook zur Schreibtransaktion.
  - `schema_version` steht live bei ca. 557.000.
  - Der Header-Watchdog meldet das alle 15 Minuten als Korruption (7.433 ALERTs).
  - Billigster Fix: Der Hook öffnet mit dem vorhandenen `{readonly:true}`, und Trigger werden nur noch bei Migrationen angelegt.
- **Doppelte Taxonomie:** `metadata.kind` und `metadata.type` existieren parallel. 507 TIM-eigene Einträge haben keins von beiden; dazu kommen 4.148 hmem-Importe.
- **Typprüfung:** Testdateien werden nirgends typgeprüft. Das betrifft ca. 76 echte Fehler, darunter wirkungslose Assertions in `session-briefing.test.ts`. `npm run lint` direkt nach dem Build ist ein No-op.
- **Betrieb:**
  - Die laufende Installation ist weiterhin der Dev-Checkout.
  - Die error_log-Kompaktierung lief an 18 Tagen in Folge nicht, weil immer ein MCP-Prozess lebt.
  - Tests schreiben in das Produktions-Verzeichnis `~/.tim`: 99,7 % von `remember.log` sind Testverkehr, und es gibt ein Projekt P0071 „Direct Test“.

**Sicherheit**

- **Memory-Injektion ohne Datenrahmung:** Wieder eingespeistes Memory ist nur in zwei Tool-Beschreibungen als Daten gekennzeichnet, Hook-Injektionen gar nicht. Die Forschung zeigt, dass persistentes Memory Prompt-Injection dauerhaft macht: PMPA (09/2026) erreichte 81,7 % Cross-Session-Erfolg gegen Claude Code.
- **Offener Regelkanal:** Seit `a7d9705` ist `P0000/Rules` ein projektübergreifender Instruktionskanal, in den jeder Agent ohne Autoritätsprüfung schreiben kann.
- **Daten an Dritte:** Zwei von drei Jev-Aufrufstellen senden Memory-Inhalte an OpenRouter, sobald ein Key existiert. Einen Config-Schalter dafür gibt es nicht.
- **Keine Redaction beim Capture:** 41 Exchanges enthalten Key-Präfixe, allerdings kein vollständiger Key. 0 Einträge sind als secret markiert.
- **Abhängigkeiten:** npm audit meldet 9 Advisories (4 high; nur Produktion: 5, davon 2 high). Sie sind nach dem Audit vom 25.09. erschienen; der Lockfile ist unverändert.

**Nachhaltigkeit**

- Bus-Faktor 1. 528 von 814 Commits haben einen KI-Co-Autor.
- Das Repo ist öffentlich, hat aber keine Lizenz.
- npm `latest` steht auf dem Stand vom 19.07.; 398 Commits sind seitdem unveröffentlicht.

## 5. Markt und Evidenz (Stand 2026-10-03)

**Host-Memory.** Claude Code, Codex, Copilot, Gemini CLI und Devin Desktop haben jeweils eigenes Memory. Es ist aber:
- auf einen Host beschränkt,
- meist maschinenlokal oder beim Anbieter gehostet,
- laut den Anbietern selbst AGENTS.md/CLAUDE.md nachgeordnet.

Zwischen Hosts gibt es nur einmalige Migration, kein Live-Sharing. Die Cross-Host-Lücke besteht also weiter.

**Open-Source-Konkurrenz.**
- **claude-mem** (95k Stars, 16k npm-Downloads pro Woche) hat nahezu TIMs Capture-Architektur: Hooks, SQLite + FTS5, KI-Summaries, Viewer.
- **ai-memory** bietet typisierte Handoffs, Multi-Machine-Betrieb und Team-Auth.
- **engram** ist ein Go-Binary mit Handoff und `topic_key` für Decisions, die sich weiterentwickeln.
- **beads** besetzt das Feld „Tasks als Agent-Memory“.

TIMs Projekt- und Handoff-Modell ist damit kein Alleinstellungsmerkmal mehr.

**Evidenz für Nutzen** (überwiegend Hersteller- oder Eigenmessungen):

| Quelle | Effekt |
|---|---|
| Copilot Memory (Produktions-A/B, GitHub-Blog 01/2026) | +7 pp Merge-Rate |
| Subtask-Memory (arXiv 2602.21611) | +4,7 pp auf SWE-bench Verified |
| ReasoningBank | +4,6 % auf SWE-bench Verified |
| Letta Skills | +15,7 pp auf Terminal-Bench 2.0 |
| DreamBench-SWE (Aufgaben, die frühere Sessions zwingend brauchen; ein Autor, eher Obergrenze) | 11,7 % → 45–54 % |

**Gegenevidenz.**
- **Kontextdateien** (arXiv 2602.11988): LLM-generierte Kontextdateien mit Repo-Überblicken, die die vorhandene Doku wiederholen, senkten den Erfolg um 0,5–2 pp und erhöhten die Kosten um 20–23 %. Entwicklergeschriebene Dateien mit neuer Information brachten dagegen ca. +4 pp. Für TIM heißt das: Redundante und veraltete Teile des Briefings schaden, etwa die 31 % veralteten Recalls oder eine Roadmap von „Cycle 66“. Die Mechanik selbst ist nicht das Problem.
- **Unselektiertes Memory:** Unselektierte Erfahrung bringt wenig oder schadet. Selektives Vergessen bringt ca. +10 %.
- **Retrieval-Benchmarks** wie LongMemEval und LoCoMo sind gesättigt und werden nur selbst berichtet.

## 6. Empfehlungen (nach Hebel)

1. **Effekt auf echten Tasks messen.** Den A/B-Aufbau dieses Reviews zu einem wiederholbaren Eval ausbauen:
   - Mit und ohne TIM, zusätzlich gegen Host-Memory bzw. eine Progress-Datei.
   - Mehrere Projekte, echte Tasks statt Fragen.
   - Messgrößen: Erfolg, Tokens, Fehlentscheidungen.
   - Zusätzlich die passiven Pfade instrumentieren: Welche Teile des Briefings nutzt der Agent tatsächlich?

   Das ist vor allem ein **Entscheidungswerkzeug** dafür, was bleibt und was fliegt. Für ein Produkt wäre es zugleich ein starkes Argument; Copilot und Letta zeigen, dass solche Zahlen überzeugen.
2. **Rauschen und Kosten senken.**
   - `tim_write`/`tim_update` geben nur `id` und geänderte Felder zurück. Das spart ca. 30–35 % des In-Context-Traffics.
   - Prompt-Hook read-only öffnen und Trigger nur bei Migrationen anlegen.
   - Reminder und Briefing ohne veraltete Open-Item-Recalls und ohne veraltete Roadmap-Previews.
   - Summarizer: Solange er über Abo-Quota läuft, keinen Wechsel auf die bezahlte API. Erst wenn die Quota knapp wird, den Harness-Overhead (11k gecachte Instruktionen pro Call) reduzieren.
3. **Den Kernnutzen schärfen statt Fläche bauen.**
   - Decisions und Learnings nur bei hoher Trefferpräzision zur Task-Query ins Briefing holen. Ein Precision-Gate verhindert, dass neuer Ballast entsteht.
   - Sync eingefroren lassen, bis es Nutzer dafür gibt; das Redesign ist ohnehin offen.
   - `tim_remember` samt Skill und den 2 übersprungenen Tests entfernen: ungenutzt, defekt, und Jev deckt das Reranking ab.
   - Den hmem-Altbestand archivieren oder mit Decay versehen.
4. **Betrieb gesund machen.**
   - Tests strikt von `~/.tim` isolieren.
   - Die Kompaktierung so bauen, dass sie trotz laufender MCP-Prozesse läuft.
   - Einen Idle-Sweep mit Lease statt einem pro Prozess.
   - Crons ins Repo holen.
   - Die Installation vom Dev-Checkout trennen.
   - Die veraltete Repo-Doku korrigieren (`docs/cron.md` zum Disk-Incident) und die veralteten TIM-Knoten aus dem A/B-Test (Q4, Q9, Q10).
5. **Sicherheit.**
   - Datenrahmung für jede Hook-Injektion.
   - Autoritäts-Gate für `P0000/Rules`.
   - Config-Schalter für alle Jev-Aufrufstellen.
   - Redaction beim Capture.
   - Advisories (#40) schließen.
6. **Nur falls ein öffentliches Produkt gewünscht ist:** Lizenz, Installation mit einem Befehl (`npx`), npm-Release. Positionieren über das, was der A/B-Test belegt (Begründungen, Stand und Gescheitertes, cross-host), und über gemessenen Effekt. Temporal/Evidence taugen derzeit nicht als Argument, weil sie ungenutzt sind.

## Methode und Grenzen

Acht parallele Agenten haben die Grundlagen erhoben:

- **Nutzungsanalyse:** SQL auf dem Snapshot sowie Transcripts von Claude Code, Codex, Cursor und Hermes.
- **Kosten:** 92 Claude-Code-Sessions seit 19.09., dazu Logs, Prozesse und Crons.
- **Code und Regressionen:** `npx vitest run` ohne Rebuild, `tsc` pro Package.
- **Markt und Evidenz:** Primärquellen mit Datum. Stars und arXiv-IDs wurden stichprobenartig nachgeprüft.
- **A/B-Test:** Fragensteller, zwei Arme, blinder Juror.

Danach hat ein adversarialer Kritiker die tragenden Zahlen stichprobenartig nachgerechnet und gegen die Rohdaten geprüft. Seine Korrekturen sind eingearbeitet.

Die Live-DB wurde nicht beschrieben, und der Workflow hat keine Sessions angelegt. Das Repo blieb bis auf diese Datei unverändert.

Grenzen:

- n=1 Nutzer, überwiegend Self-Dogfooding.
- Der A/B-Test misst Wissensabruf, nicht Task-Erfolg. Er lief auf dem bestgepflegten Projekt, mit Fragen aus TIM und ohne Host-Memory-Baseline.
- `entry_usage` misst Exposition, nicht Nutzung.
- Relevanzurteile zu Remindern stammen von einem einzelnen Agenten.
- Effektgrößen aus der Literatur sind meist Hersteller- oder Eigenmessungen.

Rohdaten: Workflow-Run `wf_842c19f9-d62` (Journal im Session-Verzeichnis).
