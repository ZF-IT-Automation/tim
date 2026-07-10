# TIM Contrary Review v2 — Der Fall gegen das Projekt, Stand 2026-07-10

> Erstellt 2026-07-10 auf HEAD `668ec4e`. Auftrag: komplettes Contrarian-Review auf
> aktuellem Stand, im Kontext des erklärten Ziels **"Der MCP muss production ready
> werden"**. Nachfolger von `REVIEW-contrary.md` (2026-07-07, HEAD `656c134`, seitdem
> als historisch markiert). Methode unverändert: der stärkste ehrliche Fall **gegen**
> Prämissen, Richtung und Ressourceneinsatz — Advocatus Diaboli, aber jede Behauptung
> gegen Repo-Stand, Git-Historie oder eigene Docs geprüft. Am Ende steht, wo dieser
> Fall selbst am schwächsten ist.

## Was sich seit v1 (2026-07-07) geändert hat — die Bilanz vorweg

53 Commits in 3 Tagen. Davon nachweislich adressiert aus v1/fable5:

- ✅ `node_modules/` ist aus dem Git-Index (v1 §7: 4.818 Dateien — weg).
- ✅ Harness-Detection gefixt **und** erstmals regressionsgetestet
  (`session-start-script.test.ts`: 6 Tests inkl. Injection-Härtung; v1 §4 nannte sie
  "only by accident" funktionierend).
- ✅ Testsuite grün: 921 passed / 2 skipped — die 4 tolerierten Baseline-Failures
  aus v1 §7 sind Geschichte.
- ✅ CI existiert und baut vor dem Test (`npm run build` vor `npm test` in
  `ci.yml`) — der Stale-dist-P0-Mechanismus ist in CI entschärft.

Das ist reale Hygiene-Arbeit und wird unten nicht kleingeredet. Aber: **jeder
einzelne strukturelle Einwand aus v1 steht unverändert** — und drei davon haben
sich in denselben drei Tagen messbar *verschärft*. Der Rest dieses Dokuments
belegt das.

## These

TIM ist handwerklich besser geworden und strategisch stehengeblieben. Das neue
Ziel "production ready" verschärft jede offene Frage aus v1, statt sie zu
beantworten — denn "production" impliziert Nutzer, Betriebsverantwortung und
definierte Fertigkeit, und für alle drei fehlt weiterhin die Grundlage:

1. **Production ready ist undefiniert.** Es gibt kein Kriterium, keine Definition
   of Done, keine Checkliste im Repo, gegen die "ready" je festgestellt werden
   könnte. Das Ziel ist derzeit ein Gefühl, kein Zustand.
2. **Production für wen?** Weiterhin N=1 User, N=1 Agent-Stack, und die einzige
   gebundene Projektdatei im Repo-Root sagt `{"project": "P0063"}` — TIM selbst.
3. **Die Kernthese bleibt ungemessen** — und die Oberfläche wächst schneller denn je.

---

## 1. Das Wirksamkeits-Loch ist jetzt drei Reviews alt

Unverändert aus v1, darum kurz: Das Produktversprechen ("Agent erinnert sich —
User wiederholt nichts") ist nach inzwischen ~192 Commits, 22.236 Zeilen Source
und 20.132 Zeilen Tests **weiterhin ungeprüft**. Der Retrieval-Benchmark misst
Retrieval gegen ein selbstgebautes Golden-Set — Zirkelschluss. Der
A/B-Vergleich (gleiche Aufgabe, TIM an vs. `CLAUDE.md`+grep, Turns/Wieder-
holungen/Fehlgriffe zählen) kostet einen Nachmittag und wurde durch inzwischen
**fünf** Review-Dokumente hindurch nicht gemacht.

Neu ist nur die Fallhöhe: v1 nannte das eine "Wette auf eine ungetestete
Prämisse". Wer dieselbe Wette jetzt "production ready" machen will, erklärt sie
für gewonnen, ohne je gespielt zu haben. Ein Produkt production-ready zu machen,
dessen Wirksamkeit nie gemessen wurde, heißt: die Verpackung härten, bevor man
weiß, ob etwas drin ist.

## 2. Die Oberfläche wächst schneller als je zuvor — Empfehlung invertiert

v1 zählte **42** MCP-Tools und empfahl eine Tool-Diät auf ~10. Drei Tage später
registriert `tim-mcp/src/server.ts` **48** eindeutige `tim_*`-Tools. Die
Empfehlung wurde nicht ignoriert — sie wurde **invertiert**: +6 Tools in 3 Tagen,
+14% Oberfläche, während das Vision-Paper weiterhin "37" behauptet. Die Spec
hinkt der Realität jetzt um 11 Tools hinterher; nicht einmal die eigene
Dokumentation kommt beim Zählen mit.

Für das Production-Ziel ist das nicht Stilkritik, sondern Arithmetik: **Jedes
Tool ist Production-Fläche.** 48 Tools production-ready machen heißt 48
Fehlerkontrakte, 48 Input-Validierungen, 48 dokumentierte Verhaltensgarantien,
48 Deprecation-Pfade. Der billigste Weg zu "production ready" ist nicht härten,
sondern **streichen** — und das Repo läuft mit Tempo in die Gegenrichtung.

## 3. Die Plan-Produktion hat sich verdoppelt — die Umsetzungsschuld auch

v1 monierte 12 Plan-Dokumente (~6.500 Zeilen) in fünf Tagen. Stand heute:
**24 Dateien in `docs/plans/`** — Verdopplung in drei Tagen, darunter die neue
Serie 12c–12f (Secret Nodes, Silbertablett, Hosted MCP, hmem-Heritage). Dazu im
Repo-Root: vier Review-Dokumente, und dieses hier ist das **fünfte**.

Das Muster aus v1 §8 hat sich dabei nicht abgeschwächt, sondern beschleunigt:
Die zwei beschlossenen Breaking Changes des Vision-Papers — **R7** (Sessions als
Root-Nodes) und **R9** (CWD-only Discovery) — sind weiterhin unerledigte
Checkboxen in Phase 0.7. Vorbei an dieser Queue sind in denselben drei Tagen
vier neue Pläne entstanden, darunter zwei (12c, 12e), die *neue
Krypto- und Server-Oberfläche* entwerfen. Jede Woche macht R7/R9 teurer: mehr
Daten im alten Session-Layout, mehr Code auf drei koexistierenden
Discovery-Regeln. Ein "production ready"-MCP auf einem Datenmodell, dessen
eigene Spec zwei Breaking Changes ankündigt, shippt wissentlich ein
Migrations-Versprechen an Nutzer, die es dann trifft.

Und die Rekursion ist real geworden: Der heutige Arbeitstag bestand daraus, ein
Review (`REVIEW-commits-2026-07-10.md`) abzuarbeiten und unmittelbar danach das
nächste Review (dieses) zu beauftragen. Review-Durchsatz ist zur primären
Arbeitsform geworden. Das Immunsystem (v1-Steelman) ist stark — aber ein
Organismus, der hauptsächlich Immunsystem ist, hat ein anderes Problem.

## 4. "Production ready" ohne Definition ist ein unlösbares Ticket

Es gibt im gesamten Repo kein Dokument, das definiert, was "production ready"
für diesen MCP bedeutet. Keine Release-Checkliste, keine SLO-artige Aussage
("Write-Pfad verliert nie Daten bei Crash X"), kein Support-Statement, keine
Versionierungs-/Deprecation-Policy für die 48 Tool-Contracts, kein definierter
Kompatibilitätsrahmen (welche Harnesses? welche Node-Versionen? welche
DB-Migrationen werden wie lange getragen?).

Ohne Definition passiert das Vorhersehbare: "production ready" wird zur
Fließband-Rechtfertigung für beliebige weitere Arbeit — jedes Feature härtet
irgendwas, jeder Plan dient irgendwie der Reife. Das Ziel kann nicht verfehlt
werden, weil es nicht existiert. Der kontraintuitive erste Schritt zur
Production-Readiness ist ein **einseitiges Dokument**, das sie definiert — und
alles von der Liste streicht, was dafür nicht nötig ist. Nach Lage der Pläne
würde diese Liste kurz und die Streichliste lang.

## 5. Privacy: unverändert widersprüchlich — jetzt mit mehr Krypto-Plänen

Der Widerspruch aus v1 §5 steht wortwörtlich noch: Roh-Exchanges — die
sensibelsten Daten im System — laufen weiterhin durch die Cloud-Fallback-Chain
des Summarizers (`generate-summary.ts` referenziert unverändert
OpenRouter/DeepSeek), es gibt weiterhin kein Threat-Model-Dokument, keinen
Secret-Scan im Write-Pfad, kein Redaktions-Tool, kein Vergessen.

Die Antwort des Projekts darauf in den drei Tagen: **Plan 12c** — Secret Nodes
mit clientseitigem AES-256-GCM/scrypt pro Teilbaum — und **Plan 12e** — ein
Hosted-MCP-Endpoint mit Tenant-Isolation. Also: mehr selbstgebaute
Krypto-Architektur und ein Mandanten-Server, geplant *vor* dem Threat-Model,
das erklären würde, wogegen das alles schützt. Das ist exakt die Reihenfolge,
vor der v1 gewarnt hat, eine Eskalationsstufe weiter. Ein Secret-Node-Feature,
dessen Inhalte auf dem Weg in die DB durch einen unverschlüsselten
Cloud-Summarizer laufen *könnten*, ist keine Privacy-Garantie, sondern eine
Privacy-Behauptung — und im Production-Kontext werden aus Behauptungen
Haftungen.

## 6. LWW, Leases, Suppression: die Production-kritischen Baustellen ruhten

Git-Log seit `656c134`: kein Commit zu Lease-Semantik, Suppression-Enforcement,
LWW-Origin-Attribution oder Konflikt-Semantik (die Treffer im Log sind ein
Merge-Commit und ein Release-Check-Kommando). Das heißt: Die in REVIEW-fable5
als P1/P2 dokumentierten Verhaltenslücken im *Kern-Datenpfad* — unbenutzbares
`tim_lease` via MCP, ¾-Suppression, verlorene Origin-Attribution für den
LWW-Tiebreak — haben drei Tage Vollgas-Entwicklung unberührt überstanden,
während Hooks, Import-Backfills und Merge-Hygiene (zu Recht) gefixt wurden.

Für ein "production ready"-Ziel ist das die falsche Sortierung: Ein
Wissensspeicher, dessen einziges Konfliktverhalten stilles Verwerfen ist
(v1 §6, unverändert), ist genau die Sorte Defekt, die man *vor* dem
Production-Stempel fixt — weil sie danach Datenverlust bei Dritten heißt.

## 7. Hygiene: echte Fortschritte, ein hartnäckiger Rest

Anerkennung wo fällig (siehe Bilanz oben) — aber der Rest ist bezeichnend:

- **420 `dist/`-Dateien im Index** — mehr als die 308 aus v1. Die Konvention,
  Build-Artefakte zu committen, wurde nicht abgeschafft, sie ist gewachsen.
- **Weiterhin kein lokales Pretest-Gate**: `"test": "vitest run"` in allen elf
  package.json, kein einziges `pretest`. CI baut vor dem Test — lokal kann
  weiterhin jeder Entwickler (d.h. jeder Agent) gegen stale dist testen. Das
  war Empfehlung **#1** aus fable5, der Mechanismus hinter dem einzigen P0 der
  Projektgeschichte, und ist nun sechs Tage und ~110 Commits alt. Eine
  Ein-Zeilen-Änderung pro Package. Dass sie durch zwei Reviews und ein
  Review-Execution-Ritual hindurch liegen blieb, während 6 neue MCP-Tools
  entstanden, ist das Prioritäten-Muster dieses Dokuments in einer Zeile.

## 8. Das Selbstreferenz-Problem ist jetzt production-relevant

v1 §2 gilt unverändert (einziges ernsthaft gepflegtes Projekt: TIM selbst;
`tim.json` bindet P0063). Neu ist die Konsequenz: Wer einen MCP "production
ready" nennt, behauptet implizit, er funktioniere für Workloads, die nicht
seine eigene Entwicklung sind. Diese Behauptung ist mit dem vorhandenen
Evidenzmaterial **nicht belegbar** — es existiert kein zweites, andersartiges,
ernsthaft betriebenes Projekt in der Datenbank, an dem die 11 Node-Types, die
Sections-Schemata und die 48 Tools je Reibung erzeugt hätten. Das günstigste
Production-Readiness-Programm wäre: zwei Wochen lang ein echtes Nicht-TIM-
Projekt (Hermes-Fork, o9k, irgendein Kundenprojekt) vollständig über TIM
betreiben und die Reibungsliste abarbeiten. Das kostet nichts außer Disziplin
und liefert mehr Readiness als jeder weitere Plan.

## 9. Phase 0.8 ist immer noch ein Geschäftsplan im Hobby-Projekt — jetzt mit Bauauftrag

v1 §9 unverändert — verschärft durch Plan 12e, der den Hosted-Endpoint vom
Roadmap-Eintrag zum Implementierungsplan mit Task-Liste befördert hat.
Tenant-Isolation, Bearer-Token-Auth, Blind-Sync-Tiers: Das ist
Betreiber-Infrastruktur für zahlende Fremde, deren Existenz weiterhin durch
nichts angezeigt wird, entworfen von und für eine Ein-Personen-Basis. Jede
Stunde darin ist eine Stunde, die dem unbequemen, billigen, entscheidenden
Experiment aus §1 fehlt. Die v1-Empfehlung (File-Sync über die eine
SQLite-Datei, Phase 0.8 streichen bis Nachfrage real ist) bleibt der ökonomisch
richtige Move und wurde durch 12e faktisch abgelehnt, ohne je widerlegt zu
werden.

---

## Wo dieser Fall am schwächsten ist

- **Die Reaktionsfähigkeit ist bewiesen.** v1 listete Hygiene-Schulden; drei
  Tage später sind node_modules draußen, die Suite ist grün, CI existiert, die
  fragilste Integrationsschicht (Session-Hook) ist gehärtet *und* getestet.
  Ein Projekt, das Reviews nachweislich exekutiert, ist die Sorte Projekt, bei
  der auch dieses Dokument Wirkung haben kann — das relativiert §3 teilweise:
  die Review-Rekursion *produziert* messbare Fixes, sie ist nicht nur Diskurs.
- **Test-Substanz ist real.** 20k Zeilen Tests zu 22k Zeilen Source, 921 grüne
  Tests, Injection-Härtung mit feindlichen Payloads — das ist mehr
  Ernsthaftigkeit, als die meisten "production ready" gestempelten internen
  Tools je erreichen.
- **"Production ready" könnte bescheidener gemeint sein**, als dieses Review es
  auslegt: nicht "für zahlende Fremde", sondern "verlässlich genug, dass Bennis
  eigene Agenten-Flotte ihm blind vertrauen kann". Unter *dieser* Lesart
  schrumpfen §8 und §9 zu Nebensachen — dann aber gehört genau diese Lesart als
  Definition ins Repo (§4), und die Roadmap-Teile, die darüber hinausgehen,
  gehören gestrichen oder ehrlich als Liebhaberei markiert.
- **N=1 bleibt kein Todesurteil** — der Einwand trägt weiterhin nur, weil
  Roadmap und Pläne (Hosted MCP, Tenants, Launch) explizit über N=1 hinauszielen.

## Konsequenz, falls man diesen Review ernst nimmt

Die v1-Liste bleibt gültig (A/B-Experiment; zweites Projekt; Tool-Diät;
Phase 0.8 streichen; R7/R9 vor neuen Plänen; Threat-Model). Neu bzw. geschärft
für das Production-Ziel, in Reihenfolge:

1. **Eine Seite: Definition "production ready".** Zielgruppe, Garantien,
   Nicht-Garantien, Abnahmekriterien. Ohne diese Seite ist das Ziel
   unabschließbar und rechtfertigt beliebige Arbeit.
2. **Pretest-Gate heute.** Elf Ein-Zeilen-Änderungen. Dass diese Empfehlung ihr
   drittes Review-Dokument erlebt, ist vermeidbar.
3. **Tool-Freeze bei 48.** Kein neues MCP-Tool, bis die Zahl *sinkt*. Jedes
   bestehende Tool bekommt entweder einen Production-Contract oder fliegt
   hinter die CLI.
4. **Kern-Datenpfad vor Peripherie:** Lease, Suppression, LWW-Origin — die
   fable5-P1/P2 im Write-/Konflikt-Pfad sind die eigentliche
   Production-Blocker-Liste, nicht die Hooks (die sind jetzt gut).
5. **Plan-Moratorium:** kein Plan 12g. Die 24 existierenden Pläne sind
   Umsetzungsschuld genug; neue Pläne sind ab jetzt Prokrastination mit
   Dateinamen.
6. **Das A/B-Experiment als Gate für alles Weitere** — unverändert Empfehlung #1
   seit v1, unverändert einen Nachmittag teuer, unverändert nicht gemacht.

Der härteste Satz, aktualisiert: **TIM hat in drei Tagen bewiesen, dass es sich
reparieren kann. Es weigert sich weiterhin zu prüfen, ob es gebraucht wird —
und will jetzt production ready heißen, ohne zu definieren, wofür.** Alles
andere in diesem Dokument ist Fußnote zu diesem Satz.
