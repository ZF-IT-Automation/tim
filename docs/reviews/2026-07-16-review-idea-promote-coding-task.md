# Review: `feature/idea-promote-coding-task` (22 Commits)

**Datum:** 2026-07-16
**Reviewer:** Claude (Fable 5), Session d48fc85d
**Basis:** `master...feature/idea-promote-coding-task`, Specs in `docs/superpowers/specs/2026-07-16-*.md`

## Verdict

**Solide Arbeit, mergebar — mit einem echten Wirkungs-Loch (Finding 1).** Alle 1038 Tests grün (153 Files), dist frisch gebaut (Rebuild ergibt keinen Diff), die Specs sind sauber und der Code hält sich weitgehend daran.

## Die Idee — Bewertung

Zwei Features, ein Schema:

1. **Idea-Promote:** Ideen bekommen einen Lifecycle (`new/planned/parked/rejected`). `idea.status = 'planned'` transformiert den Eintrag **in-place** (gleiche ID) zum Task und verschiebt ihn in die Tasks-Section. `planned` ist bewusst kein Ruhezustand, sondern der Trigger.
2. **Append-only Status-History:** `task.status` wird nur noch Cache; die Wahrheit ist `task.history` (Events mit Timestamp, `by`, `note`). Coding-Tasks (`subtype: 'coding'`) bekommen harte Gates: `done` nur nach frischem `reviewed` (kein `changes_pending` danach), und bei `vcs === 'git'` zusätzlich `pushed` + mindestens ein Commit.

**Die Idee ist richtig.** Sie löst das reale Problem — Worker, die "done" sagen, ohne dass jemand reviewed hat. Besonders gut:

- **In-place Promote statt Copy+Link** — keine Duplikate, keine Edge-Verwaltung, ID bleibt stabil.
- **History statt Booleans** — `reviewed: true` konnte man überschreiben; "frisches Review nach dem letzten `changes_pending`" ist das richtige Modell für den Review-Loop.
- **`vcs`-Gate über Worktree-Check** statt "git installiert" — korrekt gedacht.
- **Gate wirft harte Fehler** im Update-Pfad statt nur Warnings — ein Agent kann es nicht ignorieren.
- Migration (bare `status` → History-Seed, `reviewed: true` → Event, lazy beim nächsten Update) ist idempotent und getestet.

## Findings

### 1. `vcs` wird nie automatisch gesetzt — die Git-Gates greifen praktisch nicht (wichtigstes Finding)

Die Auto-Detection läuft nur, wenn der Aufrufer `projectPath` an `write`/`update` übergibt. Das tut **niemand**: weder `packages/tim-mcp/src/server.ts` noch die CLI reichen `projectPath` durch — die einzigen Verwendungen sind in `tim-store` selbst (`store.ts:1592`, `store.ts:1733`). Folge: Bei einem echten Coding-Task via `tim_update` bleibt `vcs` unset, das Done-Gate prüft nur das Review, nicht Push/Commits. Die Spec nennt das "lenient until set" — aber nichts setzt es je, und der Agent-Contract (`docs/project-schema.json`) sagt dem Agenten auch nicht, dass er `vcs` manuell setzen muss.

**Fix:** Im MCP-Server bei `tim_update`/`tim_write` den bereits bekannten Projekt-Pfad (Session-Binding/`.tim-project`) als `projectPath` durchreichen — eine Zeile pro Tool. Ohne das sind die Commits `200ff07`/`1c8f7cf` effektiv totes Feature.

### 2. `appendTaskStatus` validiert nur das Done-Gate

Die Spec definiert mehr Transition-Regeln: `pushed` nur bei `vcs=git` + Commits ≥ 1, kein `in_progress` aus `done`, kein doppeltes `cancelled`. Implementiert ist nur das Done-Gate; der Docstring behauptet trotzdem "validating transitions". Man kann `pushed` ohne einen einzigen Commit appenden. Entweder die restlichen Regeln nachziehen oder Spec + Docstring auf "v1: nur Done-Gate" ehrlich machen.

### 3. Promote feuert auch auf Nicht-Ideen (Spec-Abweichung)

Spec: "Entry lacks `metadata.idea` but patch sets `idea.status: planned` → error, not silent create." Implementierung: Der Patch-Merge lässt `idea: {status:'planned'}` auf einem Eintrag ohne Idea-Marker durch, `applyIdeaPromote` promotet stillschweigend. Gleiches End-Resultat, aber der Guard fehlt.

### 4. Latente `planned`-Ideen promoten als Nebenwirkung

`tim_write` mit `idea.status: 'planned'` legt eine ruhende planned-Idea an (write hat keinen Promote-Pfad). Die promotet beim **nächsten beliebigen Metadata-Update** — auch bei einem reinen Tag-Update. Entweder Promote auch im Write-Pfad, oder `planned` beim Write ablehnen.

### 5. Promote hängt an genau einer Section mit Titel `Tasks`

`resolveSectionIdByTitleSync` wirft bei 0 oder ≥2 Treffern — dann schlägt das gesamte Update fehl. Projekte ohne (oder mit doppelter) Tasks-Section können nie promoten; Titel englisch hartkodiert. Fehlermeldung sollte dem Agenten sagen, was zu tun ist.

### 6. Kleinere Punkte

- Promote-Move hängt **Kind-Einträge nicht mit um** (deren `depth` stimmt danach nicht, falls eine Idee Kinder hat). `tim_move_entry` macht das vermutlich richtig — Promote nutzt einen eigenen Mini-Move.
- `tim_show`-Filter `needs_review` / `coding` **shadowen echte Tags** gleichen Namens.
- `validateIdeaMetadata` und die neuen Coding-Warnings haben **keinen produktiven Aufrufer** (nur Tests + Export) — die Warnings erreichen nie einen User. Vorbestehende Schwäche.
- `docs/project-schema.json` dokumentiert `done_at` weiter als "automatic", obwohl nichts es setzt — `deriveFinishedAt` ist der Ersatz; Doku angleichen.
- `detectProjectVcs` spawnt synchron `git` innerhalb von `updateSync` (läuft laut Kommentar in `runExclusive`-Transaktionen) — one-shot pro Task, akzeptabel solange es einmalig bleibt.

## Fazit

Konzept gut, Umsetzung sauber und gut getestet. Vor dem Merge **Finding 1 fixen** (projectPath-Wiring im MCP-Server), sonst wird das Git-Gate als Deko geshippt. Findings 2–4 als Follow-ups, 5–6 nice-to-have.

## Follow-up (2026-07-16, Cursor Grok)

- **Finding 1 — FIXED:** `resolveCallerProjectPath` + Wiring in `tim_write`/`tim_update` (`packages/tim-mcp/src/project-path.ts`, `server.ts`). Tests: `project-path.test.ts`, `vcs-project-path-wiring.test.ts`.
- **Finding 2 — FIXED:** `appendTaskStatus` enforces v1 transitions (`in_progress` not from done/cancelled, no duplicate `cancelled`, `pushed` requires `vcs=git` + commits ≥ 1) plus the coding done-gate.
- **Finding 3 — FIXED:** `applyIdeaPromote(..., { hadIdeaMarker })` — update path passes prior marker; non-idea + `idea.planned` → error.
- **Finding 4 — FIXED:** `write`/`writeSync` run promote via `applyWritePromote` — `idea.status: planned` lands as task under Tasks immediately.
- Findings 5–6: nice-to-have, offen.
