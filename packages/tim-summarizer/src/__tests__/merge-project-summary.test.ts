import { describe, it, expect } from 'vitest';
import { mergeProjectSummary, PROJECT_SUMMARY_MARKER } from '../summarize.js';

function countMarkers(s: string): number {
  return s.split(PROJECT_SUMMARY_MARKER).length - 1;
}

describe('mergeProjectSummary', () => {
  it('appends a summary block to plain description content', () => {
    const out = mergeProjectSummary('the project description', '- did A\n- did B');
    expect(out).toContain('the project description');
    expect(out).toContain(`${PROJECT_SUMMARY_MARKER}\n- did A`);
    expect(countMarkers(out)).toBe(1);
  });

  it('is idempotent — running twice yields exactly one block', () => {
    const once = mergeProjectSummary('desc', '- first summary');
    const twice = mergeProjectSummary(once, '- second summary');
    expect(countMarkers(twice)).toBe(1);
    // newest summary wins, old one stripped
    expect(twice).toContain('- second summary');
    expect(twice).not.toContain('- first summary');
    // original description preserved
    expect(twice).toContain('desc');
  });

  it('handles empty base content (summary-only)', () => {
    const out = mergeProjectSummary('', '- only summary');
    expect(out).toBe(`${PROJECT_SUMMARY_MARKER}\n- only summary`);
    expect(countMarkers(out)).toBe(1);
  });

  it('trims surrounding whitespace from the summary', () => {
    const out = mergeProjectSummary('desc', '\n\n- bullet\n\n');
    expect(out).toBe(`desc\n\n${PROJECT_SUMMARY_MARKER}\n- bullet`);
  });
});
