import { describe, it, expect } from 'vitest';
import { buildReleaseCheckPlan, summarizeReleaseCheck } from '../release-check.js';

describe('release-check', () => {
  it('includes beta gates in deterministic order', () => {
    const plan = buildReleaseCheckPlan({ beta: true });
    expect(plan.map(step => step.id)).toEqual([
      'git-clean',
      'build',
      'tests',
      'pack',
      'cli-smoke',
      'mcp-smoke',
      'large-files',
      'git-clean-after',
    ]);
  });

  it('summarizes blockers when a gate fails', () => {
    const summary = summarizeReleaseCheck([
      { id: 'build', ok: true, detail: 'ok' },
      { id: 'tests', ok: false, detail: '1 failure' },
    ]);
    expect(summary.status).toBe('BLOCKER');
    expect(summary.blockers).toEqual(['tests: 1 failure']);
  });
});
