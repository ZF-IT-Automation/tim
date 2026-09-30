import { describe, expect, it } from 'vitest';
import {
  isClosedBugMetadata,
  isClosedBugStatus,
  resolveBugStatusFromMetadata,
} from '../bug-status.js';

describe('bug status resolution', () => {
  it('reads metadata.bug.status with open default', () => {
    expect(resolveBugStatusFromMetadata({ bug: { status: 'open' } })).toBe('open');
    expect(resolveBugStatusFromMetadata({ bug: {} })).toBe('open');
  });

  it('reads legacy metadata.type=bug status', () => {
    expect(resolveBugStatusFromMetadata({ type: 'bug', status: 'fixed' })).toBe('fixed');
  });

  it('lets a terminal task.status close the bug', () => {
    expect(resolveBugStatusFromMetadata({ type: 'bug', task: { status: 'done' } })).toBe('done');
    expect(isClosedBugMetadata({ bug: { status: 'open' }, task: { status: 'cancelled' } })).toBe(true);
    expect(resolveBugStatusFromMetadata({ bug: { status: 'open' }, task: { status: 'todo' } })).toBe('open');
  });

  it('classifies closed statuses', () => {
    for (const status of ['fixed', 'closed', 'resolved', 'wontfix', 'done', 'documented', 'duplicate', 'cancelled']) {
      expect(isClosedBugStatus(status)).toBe(true);
      expect(isClosedBugMetadata({ bug: { status } })).toBe(true);
    }
    expect(isClosedBugStatus('open')).toBe(false);
    expect(isClosedBugMetadata({ bug: { status: 'open' } })).toBe(false);
  });
});
