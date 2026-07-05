# Plan: Due Dates & Reminders (unified dispatcher)

Status: DRAFT v2 (2026-07-04) — noch nicht beauftragt.

## Ziel

TIM soll neben Projekt-Wissen auch als Sekretärs-Gedächtnis dienen:

1. „Erinnere mich am Tag X an Y" → Node mit `kind=reminder` + `metadata.due_date`.
2. **Jede** Node mit Due Date zählt — Reminder, Task-Subnodes
   (`metadata.task.due_date`), Ideas, Notes.
3. Ein Dispatcher liefert (a) einen täglichen Morgen-Digest und (b)
   punktgenaue Pings für uhrzeitgenaue Fälligkeiten — per Telegram.

## Kernidee: Präzision steckt im Timestamp

`metadata.due_date` ist ISO 8601. Die Granularität bestimmt das Verhalten —
einheitlich für alle Node-Typen, kein zweites Feld, keine Sonderfälle:

| Wert | Bedeutung | Verhalten |
|---|---|---|
| `2026-07-15` | tagesgenau | erscheint im Digest (heute fällig / überfällig) |
| `2026-07-15T15:00` | uhrzeitgenau | Digest **plus** punktgenauer Ping um 15:00 |

## Ist-Zustand (verifiziert auf feature/plan-4-mcp-surface, f0d4bb2)

- `TaskMetadata.due_date` (ISO 8601) existiert: `packages/tim-core/src/types.ts:44`.
- `getTasks()` liest `COALESCE($.task.due_date, $.due)` und sortiert danach:
  `packages/tim-store/src/store.ts:715-751`.
- Keine kind-übergreifende Due-Abfrage, kein `what:"due"` in `tim_show`
  (`fetchByWhat`, `packages/tim-mcp/src/server.ts` ~:842-881), kein CLI-Kommando,
  kein Cron.
- Alt-Konvention (CLAUDE.md, P0066) nutzt `metadata.next_reminder_date` mit
  15-30-min-Checker — wird durch dieses Design ersetzt (Feld auf `due_date`
  migrieren oder übergangsweise coalescen).

## Design

### 1. Datenmodell

- Kanonisch: `metadata.due_date` (ISO 8601, Datum oder Datum+Zeit) auf
  beliebigen Nodes; Tasks behalten `metadata.task.due_date`.
- Query-seitig: `COALESCE($.task.due_date, $.due_date, $.due, $.next_reminder_date)`.
- `metadata.reminded_at`: Idempotenz-Marker — gesetzt, sobald der Ping/das
  finale Feuern erfolgt ist. Macht Nachhol-Läufe doppelfeuersicher.
- Optional: `metadata.recurring` (z. B. `"daily"`, `"weekly"`, cron-artig) —
  nach dem Feuern wird `due_date` weitergeschaltet statt `reminded_at` gesetzt.
- Tasks werden NIE auto-abgehakt: sie bleiben im Digest als „überfällig",
  bis jemand den Status ändert. `reminded_at` betrifft nur den
  uhrzeitgenauen Ping (einmal pingen, nicht täglich).

### 2. Store: `getDue(opts)`

Neue Methode in tim-store:

- Filter: `irrelevant = 0`, `tombstoned_at IS NULL`, Task-Status nicht
  `done`/`cancelled`, Reminder ohne gesetztes `reminded_at`.
- Parameter: `until` (Zeitstempel); liefert auch Überfälliges (due < now).
- Rückgabe inkl. `project_label` für Gruppierung und der rohen due-Präzision
  (hat Uhrzeit ja/nein).
- Kein Schema-Change; später bei Bedarf Expression-Index auf dem COALESCE.

### 3. MCP + CLI

- `tim_show what:"due"` als neuer Case in `fetchByWhat` (kein neues Tool);
  optional `with:"7d"` als Fenster.
- `tim_write` mit `kind=reminder`: Handler validiert, dass `due_date` gesetzt ist.
- CLI: `tim due [--until +1d|ISO] [--json]` — das Cron-Interface.
- Erledigen/Verschieben läuft über vorhandenes `tim_update`
  (`reminded_at` setzen bzw. `due_date` ändern) — kein neues Tool.

### 4. Dispatcher (EIN Cronjob, alle 10 min, no_agent)

Dummes Script ohne LLM (wie usage-checker/worker-reaper). Jeder Lauf:

1. **Pings:** `tim due --json` → alle uhrzeitgenauen Einträge mit
   `due <= now` und ohne `reminded_at` → Telegram-Ping pro Eintrag,
   danach `reminded_at` setzen (recurring: stattdessen `due_date`
   weiterschalten). Nachhol-sicher: Downtime verschiebt den Ping,
   verschluckt ihn nicht.
2. **Digest:** Watermark-Datei (`~/.hermes/cron-outputs/reminder-digest/.last-digest-date`)
   prüfen. Noch kein Digest heute UND lokale Zeit >= Digest-Zeit (Config,
   default 06:00) → Digest senden, Watermark setzen. Auch das ist
   selbstheilend: Server um 6:00 down → der nächste Lauf holt nach.
3. **Disk-First:** Voller Report nach `~/.hermes/cron-outputs/reminder-digest/`.

Digest-Format (Deutsch): Abschnitte „Überfällig (seit N Tagen)" und „Heute
fällig" (uhrzeitgenaue mit Uhrzeit), gruppiert nach Projekt. Leerer Digest →
keine Nachricht.

Schreibzugriffe (reminded_at, recurring-Advance) NUR über TIM-CLI/MCP,
niemals SQL direkt.

Zeitzone: Server-lokal (Europe/Berlin).

### 5. Overseer-Konvention

„Erinnere mich am X [um HH:MM] an Y" → `tim_write` nach P0066/Reminders,
`kind=reminder`, `metadata.due_date` (mit Uhrzeit nur wenn genannt/erfragt),
optional `metadata.recurring`. CLAUDE.md-Abschnitt „Reminders" auf dieses
Design aktualisieren (ersetzt `next_reminder_date` + 15-30-min-Checker).

## Non-Goals

- Kein eigener Scheduler/Queue in TIM — der Cron pollt, TIM bleibt passiv.
- Keine Einmal-Scheduler pro Reminder (`at`/systemd-Timer): fragil bei
  Reboots, das 10-min-Polling mit Idempotenz-Marker ist robuster und
  praktisch kostenlos.
- Keine Kalender-Sync (Google Calendar etc.).
- Kein neues MCP-Tool; nur `what:"due"`-Erweiterung.
- Kein Snooze/Eskalation in v1 (später denkbar: `reminded_at` löschen =
  erneut fällig).

## Offene Fragen

1. Digest-Zeit: 06:00 default ok? (Konfigurierbar; Watermark macht die
   exakte Zeit unkritisch.)
2. Uhrzeitgenaue Pings auch für Tasks mit `T15:00`-Due, oder nur für
   `kind=reminder`? (Vorschlag: einheitlich für alle — die Regel ist der
   Timestamp, nicht der Typ.)
3. `next_reminder_date`-Altbestand in P0066 migrieren oder nur coalescen?

## Aufwand & Verifikation

- Umfang: 1 Store-Methode + Tests, 1 fetchByWhat-Case + Test, 1 CLI-Kommando
  + Test, 1 Dispatcher-Script + Cron-Registrierung. STANDARD-Lane.
- Akzeptanz:
  - `tim due --json` liefert Reminder UND Task mit due_date aus zwei
    Projekten; done-Task und irrelevante Node fehlen.
  - Eintrag mit `T15:00`: Dispatcher-Lauf um 15:05 sendet genau einen Ping;
    Folge-Läufe senden nichts mehr (`reminded_at`).
  - Digest: erster Lauf nach 06:00 sendet genau einen Digest pro Tag
    (Watermark); tagesgenaue und uhrzeitgenaue Einträge von heute enthalten.
  - Recurring-Reminder hat nach dem Feuern ein neues `due_date` und kein
    `reminded_at`.
