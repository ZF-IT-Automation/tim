#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  generateSubstanceVerdict,
  type SubstanceProjectContext,
} from './generate-summary.js';

interface FixtureSession {
  sessionTitle: string;
  summaryText: string;
  expected: 'none' | 'real' | 'low';
}

interface Fixture {
  projectContext: SubstanceProjectContext;
  sessions: FixtureSession[];
}

function isNone(label: string): boolean {
  return label === 'none';
}

export async function evalSubstanceFixture(fixture: Fixture): Promise<{
  correct: number;
  total: number;
  results: Array<{ sessionTitle: string; expected: string; got: string; match: boolean }>;
}> {
  const results: Array<{ sessionTitle: string; expected: string; got: string; match: boolean }> = [];

  for (const session of fixture.sessions) {
    const got = (await generateSubstanceVerdict(
      session.summaryText,
      undefined,
      fixture.projectContext,
    )) ?? 'low';
    const expectedNone = isNone(session.expected);
    const gotNone = isNone(got);
    results.push({
      sessionTitle: session.sessionTitle,
      expected: session.expected,
      got,
      match: expectedNone === gotNone,
    });
  }

  const correct = results.filter(r => r.match).length;
  return { correct, total: results.length, results };
}

export function printEvalReport(report: Awaited<ReturnType<typeof evalSubstanceFixture>>): void {
  console.log(`Accuracy (none vs not-none): ${report.correct}/${report.total}`);
  const confusion = report.results.filter(r => !r.match);
  if (confusion.length > 0) {
    console.log('\nConfusion list:');
    for (const c of confusion) {
      console.log(`  ${c.sessionTitle}: expected=${c.expected}, got=${c.got}`);
    }
  } else {
    console.log('No confusions.');
  }
}

async function main(): Promise<void> {
  const fixturePath = path.join(__dirname, '../src/__tests__/fixtures/substance-labels.json');
  const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const report = await evalSubstanceFixture(fixture);
  printEvalReport(report);
  if (report.correct < 18) process.exit(1);
}

const isMain =
  process.argv[1]?.endsWith('eval-substance.js') || process.argv[1]?.endsWith('eval-substance.ts');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
