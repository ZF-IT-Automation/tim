import { describe, it, expect } from 'vitest';
import { resolveEntryTaskStatus } from '../task-status.js';

describe('resolveEntryTaskStatus', () => {
  it('reads canonical metadata.task.status', () => {
    expect(resolveEntryTaskStatus({ task: { status: 'done' } })).toBe('done');
    expect(resolveEntryTaskStatus({ task: { status: 'in_progress' } })).toBe('in_progress');
  });

  it('returns todo when task.status is absent', () => {
    expect(resolveEntryTaskStatus({ task: true })).toBe('todo');
    expect(resolveEntryTaskStatus({ task: {} })).toBe('todo');
    expect(resolveEntryTaskStatus({})).toBe('todo');
  });

  it('ignores legacy metadata.status', () => {
    expect(resolveEntryTaskStatus({ task: true, status: 'done' })).toBe('todo');
    expect(resolveEntryTaskStatus({ task: { status: 'todo' }, status: 'done' })).toBe('todo');
  });
});
