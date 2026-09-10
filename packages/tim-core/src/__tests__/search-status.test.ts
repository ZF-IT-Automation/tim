import { describe, it, expect } from 'vitest';
import {
  resolveEntrySearchStatus,
  resolveEntryTaskStatus,
} from '../task-status.js';

describe('resolveEntrySearchStatus', () => {
  it('returns null for plain notes without task/bug metadata', () => {
    expect(resolveEntrySearchStatus({})).toBeNull();
    expect(resolveEntrySearchStatus({ kind: 'note' })).toBeNull();
    expect(resolveEntrySearchStatus({ type: 'error', status: 'todo' })).toBe('todo');
  });

  it('defaults recognized tasks to todo and bugs to open', () => {
    expect(resolveEntrySearchStatus({ task: {} })).toBe('todo');
    expect(resolveEntrySearchStatus({ task: true })).toBe('todo');
    expect(resolveEntrySearchStatus({ bug: {} })).toBe('open');
  });

  it('preserves bug vocabulary including fixed and documented', () => {
    expect(resolveEntrySearchStatus({ bug: { status: 'fixed' } })).toBe('fixed');
    expect(resolveEntrySearchStatus({ bug: { status: 'documented' } })).toBe('documented');
    expect(resolveEntrySearchStatus({ bug: { status: 'open' } })).toBe('open');
    expect(resolveEntrySearchStatus({ bug: { status: 'wontfix' } })).toBe('wontfix');
  });

  it('preserves legacy flat status values', () => {
    expect(resolveEntrySearchStatus({ status: 'fixed' })).toBe('fixed');
    expect(resolveEntrySearchStatus({ task: true, status: 'done' })).toBe('done');
  });

  it('differs from display resolution for plain and bug entries', () => {
    expect(resolveEntryTaskStatus({})).toBe('todo');
    expect(resolveEntrySearchStatus({})).toBeNull();
    expect(resolveEntryTaskStatus({ bug: { status: 'fixed' } })).toBe('done');
    expect(resolveEntrySearchStatus({ bug: { status: 'fixed' } })).toBe('fixed');
  });
});
