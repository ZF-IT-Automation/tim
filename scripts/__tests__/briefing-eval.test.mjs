import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evalG1,
  evalG2,
  evalG3,
  evalG4,
  evalG6,
  evalG8,
  evalJevColumn,
  evalS1,
  evalS2,
  formatScorecard,
  formatProjectSummaryLine,
} from '../briefing-eval-goals.mjs';

const root = dirname(fileURLToPath(import.meta.url));

describe('briefing-eval goals', () => {
  it('scores fixtures and selftest script', () => {
    const passingLoad = [
      'P0063 — Demo Project',
      'Status: Active · 2026-09-20 · 88 tests',
      '',
      'TypeScript ## Project overview Local-first memory for agents.',
      '',
      '── Open work ──',
      '- [in_progress] Wire the harness',
    ].join('\n');

    assert.equal(evalG1(passingLoad).pass, true, 'G1 should pass fixture');

    const rendererHeader = [
      'P0063 — Demo',
      'Status: Active · last activity 2026-09-20 · 5 packages',
    ].join('\n');
    assert.equal(
      evalG2(rendererHeader, { lastActivity: '2026-09-20T12:00:00Z', liveTestCount: 88 }).pass,
      true,
      'G2 should parse renderer header with last activity and packages',
    );

    const noStatusHeader = ['P0073 — team-up', 'last activity 2026-09-23 · 12 packages'].join('\n');
    assert.equal(
      evalG2(noStatusHeader, { lastActivity: '2026-09-23T12:00:00Z' }).pass,
      true,
      'G2 should parse header without Status when project has no pipe status segment',
    );

    assert.equal(
      evalG4('no recent sessions block', { sessionCount: 0 }).na,
      true,
      'G4 should be n/a when project has no sessions',
    );

    const recentSessionsLoad = [
      'P — X',
      'Status: Active · last activity 2026-09-23',
      '',
      '── Recent Sessions (3/5) ──',
      '  4 exchanges · 2026-09-22 — did work',
      '  3 exchanges · 2026-09-20 — earlier',
      '  5 exchanges · 2026-09-18 — oldest shown',
    ].join('\n');
    assert.equal(
      evalG4(recentSessionsLoad, {
        sessionCount: 5,
        newestSubstantiveSessionDate: '2026-09-22',
      }).pass,
      true,
      'G4 should compare against newest substantive session, not trivial newest',
    );

    const failingLoad = 'No header\nNo summary\n';
    assert.equal(evalG1(failingLoad).pass, false, 'G1 should fail sparse fixture');

    const summaryOnlyAugust = [
      'P — X',
      'Status: Active · 2026-09-23',
      '',
      '── Project Summary ──',
      '',
      '- Fixed something in August 2026-08-10',
    ].join('\n');
    assert.equal(
      evalG3(summaryOnlyAugust, { lastActivity: '2026-09-23T12:00:00Z' }).pass,
      false,
      'G3 should fail single-session August summary',
    );

    const contradictHook =
      'already loaded — do NOT re-fetch it. Call tim_load_project(label="P0063") to bind.';
    assert.equal(evalG6(contradictHook).pass, false, 'G6 should fail contradiction');

    const okHook = 'ACTION: call tim_load_project(label="P0063") now to load the brief.';
    assert.equal(evalG6(okHook).pass, true, 'G6 should pass clean directive');

    assert.equal(evalS1({ looseDirectChildren: [] }).pass, true);
    assert.equal(evalS1({ looseDirectChildren: [1, 2] }).pass, false);

    const hookOpen = [
      '── Open work ──',
      '- [in_progress] Old task',
    ].join('\n');
    const staleG8 = evalG8(
      hookOpen,
      '',
      {
        openTasksByTitle: new Map([
          ['old task', { updated_at: '2026-09-01T00:00:00Z' }],
        ]),
        activeDays: ['2026-09-02', '2026-09-03', '2026-09-05', '2026-09-08', '2026-09-10', '2026-09-15', '2026-09-20'],
      },
      new Date('2026-09-23T12:00:00Z'),
    );
    assert.equal(staleG8.pass, false, 'G8 should fail stale open work');
    const dormantG8 = evalG8(hookOpen, '', {
      openTasksByTitle: new Map([['old task', { updated_at: '2026-06-01T00:00:00Z' }]]),
      activeDays: ['2026-05-30'],
    });
    assert.equal(dormantG8.pass, true, 'a paused project does not age its tasks');
    const covered = ['── Open work ──', '- [todo] Old task', '+ 2 more open tasks — tim_show'].join('\n');
    const coverDb = { openTasksByTitle: new Map([['old task', { updated_at: '2026-06-01T00:00:00Z' }]]), activeDays: [] };
    assert.equal(evalG8(covered, '', { ...coverDb, openTaskCount: 3 }).pass, true, 'named + counted = open');
    assert.equal(evalG8(covered, '', { ...coverDb, openTaskCount: 5 }).pass, false, 'two open tasks neither named nor counted');

    const score = formatScorecard([
      { id: 'G1', hard: true, pass: true, value: true, detail: 'ok' },
      { id: 'S1', hard: false, pass: false, value: 1, detail: 'loose=1' },
    ]);
    expect(score).toMatch(/hard: 1\/1/);
    expect(score).toMatch(/soft: 0\/1/);

    const summaryLine = formatProjectSummaryLine('P0063', [
      { id: 'G4', hard: true, pass: true, value: true, detail: 'ok', na: true },
      { id: 'G1', hard: true, pass: true, value: true, detail: 'ok', na: false },
    ]);
    expect(summaryLine).toMatch(/P0063  hard 1\/1/);
    expect(summaryLine).toMatch(/G4 n\/a/);

    const self = spawnSync(process.execPath, [join(root, '..', 'briefing-eval.mjs'), '--selftest'], {
      encoding: 'utf8',
    });
    assert.equal(self.status, 0, self.stderr || self.stdout);
  });

  it('S2 fails open, fixed, open and passes open, open, fixed', () => {
    const between = ['── Bugs ──', '- [open] first', '- [fixed] middle', '- [open] last'].join('\n');
    assert.equal(evalS2(between).pass, false, 'a fixed bug before the last open bug fails');

    const after = ['── Bugs ──', '- [open] first', '- [open] second', '- [done] after'].join('\n');
    assert.equal(evalS2(after).pass, true, 'fixed bugs after the last open bug pass');

    // tim_load_project renders Bugs as an indented section, not a ── block.
    const indented = [
      '  Bugs',
      '    Bug and error tracking',
      '    still open [open]',
      '    shipped [done]',
      '    still open too [todo]',
      '  Decisions',
    ].join('\n');
    assert.equal(evalS2(indented).pass, false, 'indented Bugs section uses the same last-open rule');
  });

  it('Jev column is advisory and skips when answers are missing', () => {
    const goals = [
      { id: 'G1', hard: true, pass: true, value: true, detail: 'ok' },
      { id: 'S1', hard: false, pass: false, value: 1, detail: 'loose=1' },
    ];
    const bare = formatScorecard(goals);
    const skipped = formatScorecard(goals, { status: 'skipped', detail: 'jev: skipped' });
    expect(skipped.startsWith(bare)).toBe(true);
    expect(skipped).toMatch(/jev: skipped$/);
    expect(skipped).toMatch(/hard: 1\/1  soft: 0\/1/);
    expect(formatProjectSummaryLine('P0063', goals, { status: 'fail' })).toMatch(
      /P0063  hard 1\/1  soft 0\/1  jev fail$/,
    );

    const texts = { hook: 'ACTION: call tim_load_project', preview: '', load: 'no handoff here' };
    const noul = (n) => ({ type: 'noul', noul: n });
    const answers = (over = {}) => ({
      handoff: noul(0.1),
      g3_window: noul(0.8),
      g6_already: noul(0.2),
      g6_call: noul(0.95),
      g7: noul(0.1),
      ...over,
    });

    expect(evalJevColumn(null, texts).status).toBe('skipped');
    expect(evalJevColumn({ handoff: noul(0.1) }, texts).status).toBe('skipped');
    expect(evalJevColumn(answers(), texts).status).toBe('pass');
    expect(evalJevColumn(answers({ g6_already: noul(0.7), g6_call: noul(0.7) }), texts).status).toBe('fail');
    expect(evalJevColumn(answers({ g6_already: noul(0.9), g6_call: noul(0.69) }), texts).status).toBe('pass');
    expect(evalJevColumn(answers({ g7: noul(0.7) }), texts).status).toBe('fail');
    expect(evalJevColumn(answers({ g3_window: noul(0.49) }), texts).status).toBe('fail');
    expect(evalJevColumn(answers({ g3_window: noul(0.5) }), texts).status).toBe('pass');
    expect(evalJevColumn(answers({ handoff: noul(0.5) }), texts).status).toBe('fail');
    expect(evalJevColumn(answers({ handoff: noul(0.49) }), texts).status).toBe('pass');
    const shown = { ...texts, preview: '── Latest handoff\ndone: x | next: y' };
    expect(evalJevColumn(answers({ handoff: noul(0.49) }), shown).status).toBe('fail');
    expect(evalJevColumn(answers({ handoff: noul(0.5) }), shown).status).toBe('pass');
  });
});
