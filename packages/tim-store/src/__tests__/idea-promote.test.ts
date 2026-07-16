import { describe, it, expect } from 'vitest';
import { applyIdeaPromote, isCodingNeedsReview } from '../idea-promote.js';

describe('isCodingNeedsReview', () => {
  it('returns true for coding task with commits and not reviewed', () => {
    expect(
      isCodingNeedsReview({
        task: { subtype: 'coding', commits: ['abc123'], reviewed: false },
      }),
    ).toBe(true);
  });

  it('returns false when reviewed is true', () => {
    expect(
      isCodingNeedsReview({
        task: { subtype: 'coding', commits: ['abc123'], reviewed: true },
      }),
    ).toBe(false);
  });

  it('returns false when commits array is empty', () => {
    expect(
      isCodingNeedsReview({
        task: { subtype: 'coding', commits: [], reviewed: false },
      }),
    ).toBe(false);
  });

  it('returns false when subtype is missing', () => {
    expect(
      isCodingNeedsReview({
        task: { commits: ['abc123'], reviewed: false },
      }),
    ).toBe(false);
  });
});

describe('applyIdeaPromote', () => {
  const nowIso = '2026-07-16T12:00:00.000Z';

  it('promotes when idea.status is planned and no task yet', () => {
    const result = applyIdeaPromote(
      { idea: { status: 'planned' }, type: 'idea' },
      nowIso,
    );

    expect(result.didPromote).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.metadata.idea).toBeUndefined();
    expect(result.metadata.type).toBe('task');
    expect(result.metadata.task).toEqual({ status: 'todo' });
    expect(result.metadata.provenance).toEqual({
      promoted_from_idea_at: nowIso,
    });
  });

  it('no-ops when idea.status is not planned', () => {
    const metadata = { idea: { status: 'new' }, type: 'idea' };
    const result = applyIdeaPromote(metadata, nowIso);

    expect(result).toEqual({ metadata, didPromote: false });
  });

  it('errors when already a task and idea.status planned', () => {
    const metadata = {
      idea: { status: 'planned' },
      task: { status: 'todo' },
      type: 'idea',
    };
    const result = applyIdeaPromote(metadata, nowIso);

    expect(result.didPromote).toBe(false);
    expect(result.error).toMatch(/already a task/i);
    expect(result.metadata).toBe(metadata);
  });

  it('errors when idea value is not an object marker', () => {
    const metadata = { idea: 'planned', type: 'idea' };
    const result = applyIdeaPromote(metadata, nowIso);

    expect(result.didPromote).toBe(false);
    expect(result.error).toMatch(/idea/i);
    expect(result.metadata).toBe(metadata);
  });

  it('copies nested priority from idea.priority if present', () => {
    const result = applyIdeaPromote(
      { idea: { status: 'planned', priority: 'high' }, type: 'idea' },
      nowIso,
    );

    expect(result.didPromote).toBe(true);
    expect(result.metadata.task).toEqual({ status: 'todo', priority: 'high' });
  });
});
