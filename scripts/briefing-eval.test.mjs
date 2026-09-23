#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evalG1,
  evalG3,
  evalG6,
  evalG8,
  evalS1,
  formatScorecard,
} from './briefing-eval-goals.mjs';

const root = dirname(fileURLToPath(import.meta.url));

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
  },
  new Date('2026-09-23T12:00:00Z'),
);
assert.equal(staleG8.pass, false, 'G8 should fail stale open work');

const score = formatScorecard([
  { id: 'G1', hard: true, pass: true, value: true, detail: 'ok' },
  { id: 'S1', hard: false, pass: false, value: 1, detail: 'loose=1' },
]);
assert.match(score, /hard: 1\/1/);
assert.match(score, /soft: 0\/1/);

const self = spawnSync(process.execPath, [join(root, 'briefing-eval.mjs'), '--selftest'], {
  encoding: 'utf8',
});
assert.equal(self.status, 0, self.stderr || self.stdout);

console.log('briefing-eval.test.mjs: ok');
