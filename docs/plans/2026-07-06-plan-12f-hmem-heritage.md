# Plan 12 F: hmem-Erbe (Implementierungsplan)

> Basierend auf `docs/plans/2026-07-04-plan-12-memory-power.md` §F
> Feature-Gap-Schließung: User-Model, Handoff, Skill-Sync, Multi-Host, Checkpoint-Kadenz, Token-Budget.

## Task 1: User Model (`kind=human`)

- Konventionierter Baum unter Human-Root (`H0000`, `metadata.kind=human`)
- `tim user init` — Scaffold (Identity, Skills, Preferences, Context)
- `tim user profile` — Anzeige des Profilbaums

**Files:** `packages/tim-store/src/user.ts`, `packages/tim-cli/src/user.ts`

**Tests:** 3+

## Task 2: Handoff Contract

- `tim-handoff` Skill (<50 Zeilen Kern)
- Checkpoint schreibt optionale `handoff_note` in Summary-Metadata

**Files:** `packages/tim-skills/`, `packages/tim-store/src/session.ts`

**Tests:** 2+

## Task 3: Skill Sync on Update

- `tim update-skills` kopiert Skills in erkannte Host-Verzeichnisse
- `postinstall` auf tim-cli triggert update-skills (best-effort)

**Files:** `packages/tim-cli/src/update-skills.ts`

**Tests:** 2+

## Task 4: Multi-Host Installer

- `tim init` erkennt Claude Code, Cursor, OpenCode, Gemini CLI
- Schreibt MCP-Config pro Host

**Files:** `packages/tim-cli/src/install.ts`

**Tests:** 3+

## Task 5: Checkpoint Cadence Counter

- Config `checkpoint.everyN` (default 20)
- Nach N Exchanges Auto-Checkpoint + Marker-Zähler
- Dezente Erinnerung im Briefing wenn `exchanges % everyN >= everyN - 3`

**Files:** `packages/tim-hooks/src/cadence.ts`, `packages/tim-core/src/config.ts`

**Tests:** 3+

## Task 6: Token Budget in `tim_stats`

- Schätzung chars/4 pro Projekt
- Config `briefing.maxTokens` (default 9000)
- Flag `overBriefingBudget` wenn Projekt-Briefing zu fett

**Files:** `packages/tim-store/src/token-budget.ts`, `tim-mcp` tim_stats

**Tests:** 3+

## Branch

`feature/plan-12ef`

## Test-Plan: 16 Tests total
