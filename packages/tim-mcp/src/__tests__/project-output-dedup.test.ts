/**
 * Cross-section dedup (self-improving-loop iteration 3a).
 *
 * A cold-agent eval of a real project's briefing flagged that two sections
 * ("Usage" and "Context") were byte-identical below their first line, burning
 * budget and forcing the agent to re-read to check they didn't diverge.
 *
 * formatProjectOutput now renders each top-level section's body into a temp
 * buffer; a second section with an identical body collapses to a reference
 * line instead of repeating the content. Short/empty bodies are never deduped
 * (they may coincidentally match).
 */

import { describe, it, expect } from 'vitest';
import { formatProjectOutput } from '../project-output.js';

const project = {
  id: 'P1',
  metadata: { label: 'P1', kind: 'project' },
  title: 'P1 — x',
  content: '',
  tags: [],
  createdAt: '2026-06-01T00:00:00Z',
} as any;

function section(id: string, title: string, order: number) {
  return {
    id,
    parentId: 'P1',
    title,
    metadata: { order },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;
}

function child(id: string, parentId: string, title: string) {
  return {
    id,
    parentId,
    title,
    metadata: { order: 0 },
    tags: [],
    content: '',
    createdAt: '2026-06-01T00:00:00Z',
  } as any;
}

const LONG = 'Character-Gen-Redesign implementiert und Trait-System 20-Achsen Tool-Gate Architecture 2026-04-16';

describe('formatProjectOutput cross-section dedup', () => {
  it('collapses a section whose body is identical to an earlier one', () => {
    const children = [
      section('usage', 'Usage', 0),
      child('u1', 'usage', LONG),
      section('context', 'Context', 1),
      child('c1', 'context', LONG),
    ];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);

    // Both section headers still appear.
    expect(out).toMatch(/^ {2}Usage$/m);
    expect(out).toMatch(/^ {2}Context$/m);
    // The duplicated body is rendered exactly once.
    const occurrences = (out.match(new RegExp(LONG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    expect(occurrences).toBe(1);
    // The second section references the first instead of repeating.
    expect(out).toMatch(/\(inhaltsgleich mit "Usage" — nicht wiederholt\)/);
  });

  it('does NOT dedup short/insubstantial bodies that coincidentally match', () => {
    const children = [
      section('a', 'Alpha', 0),
      child('a1', 'a', 'x'), // tiny body, < DEDUP_MIN_CHARS
      section('b', 'Beta', 1),
      child('b1', 'b', 'x'),
    ];

    const out = formatProjectOutput({ project, children, truncated: false }, 200);
    expect(out).not.toMatch(/inhaltsgleich/);
    // Both tiny bodies are shown.
    const occurrences = (out.match(/^ {4}x$/gm) || []).length;
    expect(occurrences).toBe(2);
  });
});
