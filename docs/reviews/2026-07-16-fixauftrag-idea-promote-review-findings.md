# Fixauftrag: Review-Findings zu Commit 9c6abc3 (idea-promote / vcs-wiring)

**Datum:** 2026-07-16
**Typ:** Bugfix + Cleanup
**Repo:** `~/projects/tim`, Branch `feature/idea-promote-coding-task`
**Arbeitsverzeichnis:** `.worktrees/idea-promote-coding-task` — der Commit liegt NUR dort, nicht im master-Checkout. Alle Zeilenangaben beziehen sich auf den Worktree-Stand von 9c6abc3.
**Priorität:** F1 hoch (blockiert den Zweck des Commits), F2–F5 mittel/niedrig

## Kontext

Commit `9c6abc3` ("fix: address idea-promote review findings 1–4") hat projectPath in die MCP-Handler verdrahtet, Status-Transition-Rules eingeführt und Promote-on-Write ergänzt. Ein Verify-Review (8 Angles, alle Findings einzeln verifiziert) hat 1 bestätigten Bug und 4 bestätigte Cleanup-/Effizienz-Findings ergeben. Spec: `docs/superpowers/specs/2026-07-16-task-status-history-design.md`.

## Findings (alle CONFIRMED)

### F1 — Bug: pushed-Gate läuft vor der vcs-Auto-Detection

`packages/tim-store/src/store.ts` updateSync: Step 3 (Zeilen 1619–1626) ruft `appendTaskStatus` auf, dessen `transitionError` bei `status='pushed'` `task.vcs !== 'git'` prüft (`task-status-history.ts:123-125`). Die vcs-Auto-Detection (Step 4, Zeilen 1628–1631: `if (taskObj.subtype === 'coding' && !taskObj.vcs && options?.projectPath) taskObj.vcs = detectProjectVcs(...)`) läuft erst DANACH.

**Repro:** Coding-Task ohne `vcs`-Feld (z.B. via Store direkt geseedet). `tim_update({ id, metadata: { task: { status: 'pushed' } } })` mit Server-cwd in einem Git-Repo → wirft `Cannot append "pushed": vcs is not "git".`, obwohl derselbe Call vcs='git' gesetzt hätte. Genau das Szenario, das der Commit fixen sollte.

**Fix:** vcs-Detection-Step vor den Status-Append ziehen (Step 4 vor Step 3). Test ergänzen: erster-Update-direkt-auf-pushed in Git-Repo mit projectPath → Erfolg; ohne Git-Repo → weiterhin Fehler.

### F2 — Effizienz: resolveCallerProjectPath pro Tool-Call statt einmalig

`packages/tim-mcp/src/server.ts:2019` (tim_write) und `:2225` (tim_update) rufen `resolveCallerProjectPath(isHttp)` pro Request auf. `findMarker` mit walkUp macht bis zu 256 Verzeichnis-Level mit 1–2 `fs.existsSync` pro Level (`packages/tim-hooks/src/marker.ts:507-524, 432, 126`). `isHttp` und `process.cwd()` sind für die Server-Lebensdauer konstant (kein `process.chdir` im Repo).

**Fix:** Einmal in `createMcpServer` berechnen (oder lazy memoizen) und die Konstante an beiden Call-Sites verwenden.

### F3 — Effizienz: JSON-Roundtrip in applyWritePromote bei jedem Write

`packages/tim-store/src/store.ts:1466`: `applyWritePromote` macht `JSON.parse(entry.metadata)` unconditionally — direkt nachdem `buildEntryRow` (Zeile 1802) dasselbe Metadata gestringify't hat; beim Promote folgt ein zweiter stringify (1493). Jeder write/writeSync (Session-Logs, Checkpoints, Notes ohne idea-Key) zahlt den Roundtrip.

**Fix:** Promote auf dem Metadata-OBJEKT vor der Serialisierung laufen lassen (z.B. in/bei buildEntryRow), alternativ mindestens ein billiger Guard (kein `idea`-Key im Options-Metadata → skip). Verhalten identisch halten (gleiche Fehler, gleicher Endzustand).

### F4 — Duplikat: Tasks-Section-Retarget-Block zweimal

`packages/tim-store/src/store.ts:1477-1487` (applyWritePromote) ist nahezu byte-gleich zu `1670-1682` (Update-Pfad-Promote): `findProjectLabelForParent` → throw `no project ancestor found` → `resolveSectionIdByTitleSync(label,'Tasks')` → `SELECT depth FROM entries WHERE id = ?` → `Math.min((parentRow?.depth ?? 0) + 1, 5)`.

**Fix:** Privater Helper (z.B. `retargetToTasksSection(entryId, currentParentId): { parentId, depth }`), von beiden Call-Sites genutzt. Kein Verhaltens-Change.

### F5 — Duplikat: 24. Kopie der McpClient-Testklasse

`packages/tim-mcp/src/__tests__/vcs-project-path-wiring.test.ts:16` definiert die 24. nahezu identische `class McpClient` (23 bestehende Kopien, z.B. `load-project-bind.test.ts`, `write-dedup.test.ts`; Unterschiede nur Timeout 15000 vs 10000 und cwd-Param). Kein Shared Helper existiert.

**Fix:** Helper extrahieren (z.B. `packages/tim-mcp/src/__tests__/test-helpers/mcp-client.ts`, konfigurierbar: cwd, env, timeout) und MINDESTENS die neue Testdatei darauf umstellen. Die 23 Altkopien migrieren ist optional (nur wenn mechanisch risikolos, sonst Non-Goal — nicht den ganzen Testbestand anfassen).

## Non-Goals

- Keine neuen Transition-Rules (done→cancelled ist laut Spec erlaubt — Zeile 107 der Design-Spec — NICHT "fixen").
- Kein Recompute von `metadata.order` beim Promote-Retarget (Duplikate sind durch created_at-Tiebreak tolerierbar, verifiziert).
- Kein Ändern des No-Ancestor-Throws beim Write-Promote (bewusst symmetrisch zum Update-Pfad).
- Kein Anfassen des Import-Pfads (`tim-migrate`), keine Schema-/API-Änderungen.
- dist/-Dateien nur via Build regenerieren, nicht von Hand editieren.

## Verification / Acceptance

1. Neuer Test F1: Coding-Task ohne vcs, erster Update direkt auf `pushed` mit projectPath auf Git-Repo → Erfolg, `vcs='git'` gesetzt; ohne Git → Fehler bleibt.
2. Bestehende Tests grün im Worktree: `npm test` (inkl. `vcs-project-path-wiring.test.ts`, `task-status-history*`, `idea-promote*`).
3. F2: `resolveCallerProjectPath` wird pro Server-Instanz genau einmal ausgewertet (Test oder Code-Inspektion; bestehende Wiring-Tests bleiben grün).
4. F3: kein `JSON.parse` mehr auf dem Write-Hot-Path ohne idea-Metadata (Code-Inspektion), Promote-Tests unverändert grün.
5. F4/F5: keine Verhaltensänderung, nur Deduplizierung; Testsuite grün.
6. Build reproduzierbar (`npm run build`), dist-Diff nur aus dem Build.
