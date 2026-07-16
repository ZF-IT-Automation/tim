import { describe, it, expect } from 'vitest';
import { applyIdeaPromote } from '../idea-promote.js';

// isCodingNeedsReview now lives in task-status-history.ts (history-based,
// not boolean `reviewed`) — see task-status-history.test.ts for its coverage.

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
    const task = result.metadata.task as { status: string; history: Array<{ status: string; at: string }> };
    expect(task.status).toBe('todo');
    expect(task.history[0].status).toBe('todo');
    expect(task.history[0].at).toBe(nowIso);
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
    const task = result.metadata.task as { status: string; priority: string; history: Array<{ status: string }> };
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('high');
    expect(task.history[0].status).toBe('todo');
  });

  it('errors when hadIdeaMarker is false even if merged metadata has idea.planned', () => {
    const metadata = { idea: { status: 'planned' }, type: 'note' };
    const result = applyIdeaPromote(metadata, nowIso, { hadIdeaMarker: false });

    expect(result.didPromote).toBe(false);
    expect(result.error).toMatch(/not an idea|missing.*idea/i);
    expect(result.metadata).toBe(metadata);
  });

  it('promotes when hadIdeaMarker is true', () => {
    const result = applyIdeaPromote(
      { idea: { status: 'planned' }, type: 'idea' },
      nowIso,
      { hadIdeaMarker: true },
    );
    expect(result.didPromote).toBe(true);
  });
});
