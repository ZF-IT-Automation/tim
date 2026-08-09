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

  it('falls back to legacy metadata.status for legacy-shaped tasks', () => {
    expect(resolveEntryTaskStatus({ task: true, status: 'done' })).toBe('done');
    expect(resolveEntryTaskStatus({ task: true, status: 'cancelled' })).toBe('cancelled');
  });

  it('lets the canonical shape win over a legacy metadata.status', () => {
    expect(resolveEntryTaskStatus({ task: { status: 'todo' }, status: 'done' })).toBe('todo');
  });

  it('maps bug statuses onto the open/done distinction the listings filter on', () => {
    expect(resolveEntryTaskStatus({ bug: { status: 'open' } })).toBe('todo');
    expect(resolveEntryTaskStatus({ bug: {} })).toBe('todo');
    expect(resolveEntryTaskStatus({ bug: { status: 'fixed' } })).toBe('done');
    expect(resolveEntryTaskStatus({ bug: { status: 'documented' } })).toBe('done');
    expect(resolveEntryTaskStatus({ bug: { status: 'wontfix' } })).toBe('cancelled');
    expect(resolveEntryTaskStatus({ bug: { status: 'duplicate' } })).toBe('cancelled');
  });

  it('lets metadata.task win over metadata.bug when an entry carries both', () => {
    expect(resolveEntryTaskStatus({ task: { status: 'todo' }, bug: { status: 'fixed' } })).toBe('todo');
  });

  it('ignores non-task status vocabularies', () => {
    expect(resolveEntryTaskStatus({ task: true, status: 'fixed' })).toBe('todo');
    expect(resolveEntryTaskStatus({ task: true, status: 'documented' })).toBe('todo');
  });
});
