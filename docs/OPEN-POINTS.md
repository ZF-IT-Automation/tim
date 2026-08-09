# TIM — offene Punkte

Stand: 2026-08-06, Branch `claude/tim-hmem-analysis-xt5j59`.
Suite: 1526 grün, 3 rot (Umgebungsartefakte, siehe unten).

Entstanden aus einem Code-Review der Kette *Session-Ende → Summary →
Briefing der Folgesession*, plus vier Umsetzungsblöcken. Was hier steht,
ist bewusst **nicht** erledigt — mit Begründung, warum nicht.

---

## P1 — Validierung auf echter Maschine mit echter LLM-Kette

**Status:** offen, blockiert alles andere.

In der Entwicklungsumgebung war kein `opencode` installiert, die
Summarizer-Kette lief also **nie**. Verifiziert wurde ausschließlich die
Verkabelung — dass der Rollup aufgerufen wird, das `summary`-Argument
ankommt, der Fallback greift. **Nicht** verifiziert: ob die erzeugten
Zusammenfassungen inhaltlich taugen.

Zu tun:

1. `~/.tim/config.json` → `summarizer.chain` auf die tatsächlich
   installierten CLIs setzen. Der Default rät `opencode` mit
   Anthropic/DeepSeek/Moonshot (gespiegelt von `DEFAULT_REMEMBER_CHAIN`).
2. `tim doctor` muss `✓ chain: …` zeigen, nicht `⚠ … not found on PATH`.
3. Echte Session fahren → `/clear` → neue Session → knüpft das Briefing an?

Solange P1 offen ist: **keinen PR aufmachen.** Der Branch ist grün und in
sich konsistent, aber die Kernfrage ist unbeantwortet, und ein PR
suggeriert eine Fertigstellung, die es nicht gibt.

---

## P2 — Alte Summaries mit Failure-Marker nachziehen

**Status:** Erkennung fertig, Reparatur fehlt.

`tim doctor` findet jetzt Sessions, deren gespeicherte Summary noch
`[ALL SUMMARIZER CLIs FAILED` enthält — der Text, den der Summarizer bis
zu diesem Branch bei fehlender Chain in die DB geschrieben hat. Es gibt
aber **kein Kommando, das sie neu zusammenfasst**.

In einer real gewachsenen DB dürften das alle Sessions von vor diesem
Branch sein.

Skizze: `tim resummarize [--session <id> | --project <P00XX>]`, das die
betroffenen Batches über `tim_show_unsummarized` neu durch die Kette
schickt und danach `tim_rollup_session_summary` mit kondensiertem
`summary` aufruft. Die Bausteine existieren alle, nur der Einstiegspunkt
fehlt.

---

## P3 — Label-Kollision über Geräte hinweg (Sync)

**Status:** analysiert, nicht behoben. Designentscheidung nötig.

`tim-sync` ist der vorgesehene Weg für mehrere Geräte — deckt diesen Fall
aber nicht ab:

1. `store.ts:324` `allocateNextProjectLabel()` ist `max(label)+1` unter
   einer **lokalen** SQLite-Transaktion. Kein geräteübergreifendes
   Reservierungsprotokoll.
2. Entry-IDs sind global eindeutig (`<host>-<date>-<sess>-<ULID>`). Zwei
   Geräte, die offline je ein Projekt anlegen, erzeugen zwei
   **verschiedene** Entries, die beide `metadata.label = 'P0064'` tragen.
3. Sync (`sync-methods.ts` + `lww.ts`) löst Konflikte per LWW **pro
   Entry-Key**. Verschiedene IDs ⇒ kein Konflikt ⇒ beide überleben.
4. `resolveProjectLabel` benutzt im Label-Pfad `.get()` → liefert eine
   beliebige der beiden Zeilen. Der Alias-Pfad direkt darunter gibt bei
   Mehrdeutigkeit korrekt `status: 'ambiguous'` zurück. Die Asymmetrie
   zeigt: Mehrdeutigkeit ist bekannt, nur hier nicht abgesichert.
5. `sync-convergence.test.ts` testet nur Konflikte am *selben* Entry,
   nie zwei Entries mit gleichem Label.

Folge: `tim.json {"project":"P0064"}` löst nach einem Sync
nichtdeterministisch auf — genau das Szenario, das Sync reparieren sollte.

**Sofortschutz (billig, unabhängig von der Designwahl):**
`resolveProjectLabel` im Label-Pfad genauso `ambiguous` liefern lassen wie
im Alias-Pfad. Macht den Fehler laut statt still.

**Richtige Lösung — offene Entscheidung:**

| Option | Idee | Kosten |
|---|---|---|
| a | Gerätepartitionierte Label-Bereiche (A: P0001–4999, B: P5000–8999) | einfach, endlich, unschön bei >2 Geräten |
| b | Entry-UID wird Primärschlüssel in `tim.json`, Label wird Anzeigename | sauberste Semantik, berührt viele Aufrufer |
| c | Post-Sync-Reconciliation meldet Label-Dubletten statt still zu wählen | additiv, verschiebt das Problem zum Nutzer |

---

## P4 — `TimStore` schreibt bei jedem Öffnen

**Status:** analysiert, nicht behoben.

`packages/tim-store/src/store.ts:224`:

```ts
constructor(dbPath: string, options: TimStoreOptions = {}) {
  this.db = new Database(dbPath);
  ...
  runMigrations(this.db);
  createTriggers(this.db);   // DROP/CREATE TRIGGER
}
```

Bedingungslos, ohne Flag. Konsequenzen:

- Read-only-Zugriff ist über die Store-API **unmöglich**. Der Viewer
  musste deshalb an `TimStore` vorbei (`better-sqlite3` mit
  `readonly: true`) und die SELECT-Filter in `viewer-data.ts` spiegeln —
  dokumentierte, aber echte Duplizierung.
- Rein lesende Kommandos (`tim doctor`, `tim stats`, `tim statusline`)
  mutieren die DB beim Öffnen. Die Statusline läuft je nach Setup bei
  jedem Prompt-Render.
- Öffnet auf einem Gerät eine ältere/neuere TIM-Version dieselbe DB, wird
  still migriert. Zusammen mit P3 für die Mehrgeräte-Geschichte relevant.

**Vorschlag:** `TimStore(path, { readonly: true })`, das Migration und
Trigger überspringt. Räumt zugleich die Duplizierung in `viewer-data.ts`
ab. Wurde beim Viewer-Bau schon einmal gebaut und wegen einer zu strikten
`dist/`-Auflage zurückgenommen.

---

## P5 — Kleinkram

- **`project-path`-Knoten erscheint als Section.** Die Pfad-Inventarzeile
  (`vm: /pfad/zum/repo`, `kind=project-path`) hängt als Kind am
  Projekt-Root und taucht dadurch im Renderer unter „Sections" auf.
  `formatProjectOutput` filtert nur `session-summary`, `commits-root` und
  `sessions-root` weg. Kosmetisch, aber verwirrend im Brief.
- **`.tsbuildinfo` ist getrackt**, obwohl `.gitignore` `dist/` listet und
  Feature-Commits die Buildinfo nicht enthalten. Hat beim Mergen zweimal
  aktiv gestört. `git rm --cached packages/*/tsconfig.tsbuildinfo` wäre
  fällig.
- **Drei `wip/*`-Branches auf origin** (`wip/block-b-briefing`,
  `wip/block-c-schema`, `wip/block-d-viewer`) zeigen auf bereits gemergte
  Commits. Löschen schlug remote fehl (Sideband-Disconnect, auch mit
  Backoff) — über die GitHub-UI wegräumbar.
- **Default-Summarizer-Chain ist geraten.** `DEFAULT_SUMMARIZER_CHAIN`
  spiegelt `DEFAULT_REMEMBER_CHAIN`. Semantisch sind das verschiedene
  Aufgaben (schnelles Retrieval mit 5 s Timeout vs. gründliche
  Zusammenfassung mit 600 s) — die Werte fallen heute nur zufällig
  zusammen. Sobald P1 gelaufen ist, sollten sie bewusst gesetzt werden.

---

## Bekannte Test-Failures (keine Codefehler)

Drei Failures sind Artefakte der Entwicklungsumgebung und schlagen auch
ohne jede Änderung fehl:

| Test | Ursache |
|---|---|
| `tim-store/__tests__/store.test.ts` — `should write and read an entry` | ID-Regex erwartet 4-Zeichen-Hostname-Prefix; Container-Hostname ist `vm` (2 Zeichen) |
| `tim-store/__tests__/store.test.ts` — `should assign id with session_short …` | dito |
| `tim-cli/__tests__/resolve-project.test.ts` — `prints the label` | braucht eine Live-DB mit P0063 |

Auf einer normalen Maschine mit längerem Hostnamen sollten die ersten
beiden grün sein. **Vor dem Vergleich immer `npm run clean && npm run
build`** — `tsc -b` ist inkrementell, und ein zurückgerollter
`dist/`-Stand führt zu Phantom-Failures (ist während der Umsetzung
zweimal passiert).

---

## Erledigt in diesem Branch — als Kontext

| Commit | Inhalt |
|---|---|
| `fbcd525` | Summarizer-Kette: Default-Chain, `previousSummaries` trägt Bodies statt „Batch N", LLM-Rollup statt Konkatenation, sichtbarer Degradationszustand, `tim doctor`-Check |
| `e9e7d5d` | Briefing: SessionStart-Hook wird installiert, Direktive trägt Inhalt, Renderer zerstört Summaries nicht mehr, Skill-Parität |
| `33a4b27` | Projektschema vereinheitlicht (vier divergente Definitionen → eine), `ensureProjectSchema`, `tim doctor --repair-schema` |
| `d40de0b` | `tim viewer` — read-only, loopback-only, ohne Truncation |
| `4d7ac22` | Migration benennt falsch betitelte Legacy-Sections um, statt sie zu doppeln |
