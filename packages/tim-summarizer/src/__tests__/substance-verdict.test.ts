import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  buildSubstanceVerdictPrompt,
  projectOverviewLines,
} from '../generate-summary.js';
import { evalSubstanceFixture } from '../eval-substance.js';
import * as generateSummary from '../generate-summary.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/substance-labels.json',
);

describe('substance verdict fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  it('has 20 labelled sessions with none or real expected labels', () => {
    expect(fixture.sessions).toHaveLength(20);
    for (const session of fixture.sessions) {
      expect(['none', 'real']).toContain(session.expected);
      expect(session.sessionTitle).toBeTruthy();
      expect(session.summaryText.trim().length).toBeGreaterThan(0);
    }
  });

  it('buildSubstanceVerdictPrompt includes project title and overview', () => {
    const prompt = buildSubstanceVerdictPrompt('did some work', fixture.projectContext);
    expect(prompt).toContain(fixture.projectContext.title);
    expect(prompt).toContain('THIS project');
    expect(prompt).toContain('work on another project');
    expect(prompt).toContain('did some work');
  });

  it('projectOverviewLines returns first lines only', () => {
    const lines = projectOverviewLines('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 3);
    expect(lines).toBe('a\nb\nc');
  });

  describe('evalSubstanceFixture (stubbed LLM)', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('computes accuracy and lists confusions from fixed stub verdicts', async () => {
      vi.spyOn(generateSummary, 'generateSubstanceVerdict').mockImplementation(
        async () => 'real',
      );

      const report = await evalSubstanceFixture(fixture);
      const expectedNone = fixture.sessions.filter(
        (s: { expected: string }) => s.expected === 'none',
      ).length;
      const expectedReal = fixture.sessions.filter(
        (s: { expected: string }) => s.expected === 'real',
      ).length;
      expect(report.correct).toBe(expectedReal);
      expect(report.total).toBe(20);
      expect(report.results.filter(r => !r.match)).toHaveLength(expectedNone);
      for (const row of report.results.filter(r => !r.match)) {
        expect(row.expected).toBe('none');
        expect(row.got).toBe('real');
      }
    });
  });
});
