import { describe, it, expect } from 'vitest';
import {
  getTaskHistory,
  migrateTaskHistory,
  appendTaskStatus,
  deriveStartedAt,
  deriveFinishedAt,
  isCodingNeedsReview,
} from '../task-status-history.js';

const T0 = '2026-07-16T10:00:00.000Z';
const T1 = '2026-07-16T11:00:00.000Z';
const T2 = '2026-07-16T12:00:00.000Z';
const T3 = '2026-07-16T13:00:00.000Z';

describe('getTaskHistory', () => {
  it('returns [] when history is missing', () => {
    expect(getTaskHistory({ status: 'todo' })).toEqual([]);
  });

  it('returns the history array when present', () => {
    const history = [{ status: 'todo', at: T0 }];
    expect(getTaskHistory({ status: 'todo', history })).toEqual(history);
  });
});

describe('migrateTaskHistory', () => {
  it('seeds history from a bare status field', () => {
    const result = migrateTaskHistory({ status: 'todo' }, T0);
    expect(result.history).toEqual([{ status: 'todo', at: T0 }]);
    expect(result.status).toBe('todo');
  });

  it('adds a reviewed event when legacy reviewed:true is present, and strips the boolean', () => {
    const result = migrateTaskHistory(
      { status: 'in_progress', reviewed: true },
      T1,
    );
    expect(result.reviewed).toBeUndefined();
    expect(result.history).toEqual([
      { status: 'in_progress', at: T1 },
      { status: 'reviewed', at: T1 },
    ]);
    expect(result.status).toBe('reviewed');
  });

  it('strips reviewed:false without adding an event', () => {
    const result = migrateTaskHistory({ status: 'todo', reviewed: false }, T0);
    expect(result.reviewed).toBeUndefined();
    expect(result.history).toEqual([{ status: 'todo', at: T0 }]);
  });

  it('is idempotent when history already exists', () => {
    const history = [{ status: 'todo', at: T0 }];
    const result = migrateTaskHistory({ status: 'todo', history }, T1);
    expect(result.history).toEqual(history);
  });

  it('does not duplicate a reviewed event if one is already present', () => {
    const history = [
      { status: 'todo', at: T0 },
      { status: 'reviewed', at: T1 },
    ];
    const result = migrateTaskHistory({ status: 'reviewed', history, reviewed: true }, T2);
    expect(result.history).toEqual(history);
  });
});

describe('appendTaskStatus', () => {
  it('grows history by one on each append, cache reflects last status', () => {
    let task: Record<string, unknown> = { status: 'todo', history: [{ status: 'todo', at: T0 }] };

    const first = appendTaskStatus(task, 'in_progress', { at: T1 });
    expect(first.error).toBeUndefined();
    task = first.task;
    expect(getTaskHistory(task)).toHaveLength(2);
    expect(task.status).toBe('in_progress');

    const second = appendTaskStatus(task, 'done', { at: T2 });
    expect(second.error).toBeUndefined();
    task = second.task;
    expect(getTaskHistory(task)).toHaveLength(3);
    expect(task.status).toBe('done');
  });

  it('rejects coding done without any reviewed in history', () => {
    const task = {
      subtype: 'coding',
      status: 'in_progress',
      history: [
        { status: 'todo', at: T0 },
        { status: 'in_progress', at: T1 },
      ],
    };
    const result = appendTaskStatus(task, 'done', { at: T2 });
    expect(result.error).toMatch(/reviewed/i);
    expect(result.task).toBe(task);
  });

  it('rejects coding done when changes_pending is after the latest reviewed', () => {
    const task = {
      subtype: 'coding',
      status: 'changes_pending',
      history: [
        { status: 'todo', at: T0 },
        { status: 'in_progress', at: T1 },
        { status: 'reviewed', at: T2 },
        { status: 'changes_pending', at: T3 },
      ],
    };
    const result = appendTaskStatus(task, 'done', { at: T3 });
    expect(result.error).toMatch(/reviewed/i);
  });

  it('rejects coding vcs:git done without pushed or with empty commits', () => {
    const noPush = {
      subtype: 'coding',
      vcs: 'git',
      commits: ['abc123'],
      history: [
        { status: 'todo', at: T0 },
        { status: 'reviewed', at: T1 },
      ],
    };
    const noPushResult = appendTaskStatus(noPush, 'done', { at: T2 });
    expect(noPushResult.error).toMatch(/pushed/i);

    const noCommits = {
      subtype: 'coding',
      vcs: 'git',
      commits: [],
      history: [
        { status: 'todo', at: T0 },
        { status: 'reviewed', at: T1 },
        { status: 'pushed', at: T1 },
      ],
    };
    const noCommitsResult = appendTaskStatus(noCommits, 'done', { at: T2 });
    expect(noCommitsResult.error).toMatch(/commit/i);
  });

  it('allows coding vcs:git done with reviewed, pushed, and commits', () => {
    const task = {
      subtype: 'coding',
      vcs: 'git',
      commits: ['abc123'],
      history: [
        { status: 'todo', at: T0 },
        { status: 'reviewed', at: T1 },
        { status: 'pushed', at: T1 },
      ],
    };
    const result = appendTaskStatus(task, 'done', { at: T2 });
    expect(result.error).toBeUndefined();
    expect(result.task.status).toBe('done');
  });

  it('allows coding vcs:none reviewed then done without commits', () => {
    const task = {
      subtype: 'coding',
      vcs: 'none',
      history: [
        { status: 'todo', at: T0 },
        { status: 'in_progress', at: T1 },
      ],
    };
    const reviewed = appendTaskStatus(task, 'reviewed', { at: T2 });
    expect(reviewed.error).toBeUndefined();

    const done = appendTaskStatus(reviewed.task, 'done', { at: T3 });
    expect(done.error).toBeUndefined();
    expect(done.task.status).toBe('done');
  });

  it('allows non-coding in_progress -> done without reviewed', () => {
    const task = {
      status: 'in_progress',
      history: [
        { status: 'todo', at: T0 },
        { status: 'in_progress', at: T1 },
      ],
    };
    const result = appendTaskStatus(task, 'done', { at: T2 });
    expect(result.error).toBeUndefined();
    expect(result.task.status).toBe('done');
  });

  it('rejects in_progress when current status is done', () => {
    const task = {
      status: 'done',
      history: [
        { status: 'todo', at: T0 },
        { status: 'done', at: T1 },
      ],
    };
    const result = appendTaskStatus(task, 'in_progress', { at: T2 });
    expect(result.error).toMatch(/in_progress/i);
    expect(result.task).toBe(task);
  });

  it('rejects in_progress when current status is cancelled', () => {
    const task = {
      status: 'cancelled',
      history: [
        { status: 'todo', at: T0 },
        { status: 'cancelled', at: T1 },
      ],
    };
    const result = appendTaskStatus(task, 'in_progress', { at: T2 });
    expect(result.error).toMatch(/in_progress/i);
  });

  it('rejects duplicate cancelled', () => {
    const task = {
      status: 'cancelled',
      history: [
        { status: 'todo', at: T0 },
        { status: 'cancelled', at: T1 },
      ],
    };
    const result = appendTaskStatus(task, 'cancelled', { at: T2 });
    expect(result.error).toMatch(/cancelled/i);
    expect(result.task).toBe(task);
  });

  it('rejects pushed when vcs is not git or commits empty', () => {
    const noGit = {
      subtype: 'coding',
      vcs: 'none',
      commits: ['abc'],
      history: [{ status: 'todo', at: T0 }],
    };
    expect(appendTaskStatus(noGit, 'pushed', { at: T1 }).error).toMatch(/pushed/i);

    const noCommits = {
      subtype: 'coding',
      vcs: 'git',
      commits: [],
      history: [{ status: 'todo', at: T0 }],
    };
    expect(appendTaskStatus(noCommits, 'pushed', { at: T1 }).error).toMatch(/commit/i);
  });

  it('allows pushed when vcs is git and commits exist', () => {
    const task = {
      subtype: 'coding',
      vcs: 'git',
      commits: ['abc123'],
      history: [{ status: 'in_progress', at: T0 }],
    };
    const result = appendTaskStatus(task, 'pushed', { at: T1 });
    expect(result.error).toBeUndefined();
    expect(result.task.status).toBe('pushed');
  });
});

describe('deriveStartedAt / deriveFinishedAt', () => {
  it('returns the at of the first in_progress / done event', () => {
    const task = {
      history: [
        { status: 'todo', at: T0 },
        { status: 'in_progress', at: T1 },
        { status: 'reviewed', at: T2 },
        { status: 'done', at: T3 },
      ],
    };
    expect(deriveStartedAt(task)).toBe(T1);
    expect(deriveFinishedAt(task)).toBe(T3);
  });

  it('returns null when there is no such event', () => {
    const task = { history: [{ status: 'todo', at: T0 }] };
    expect(deriveStartedAt(task)).toBeNull();
    expect(deriveFinishedAt(task)).toBeNull();
  });

  it('returns null for missing/empty history', () => {
    expect(deriveStartedAt({})).toBeNull();
    expect(deriveFinishedAt({ history: [] })).toBeNull();
  });
});

describe('isCodingNeedsReview', () => {
  it('true when coding task has commits and no fresh review', () => {
    expect(
      isCodingNeedsReview({
        task: {
          subtype: 'coding',
          commits: ['abc123'],
          history: [{ status: 'todo', at: T0 }],
        },
      }),
    ).toBe(true);
  });

  it('false when there is a fresh reviewed entry', () => {
    expect(
      isCodingNeedsReview({
        task: {
          subtype: 'coding',
          commits: ['abc123'],
          history: [
            { status: 'todo', at: T0 },
            { status: 'reviewed', at: T1 },
          ],
        },
      }),
    ).toBe(false);
  });

  it('true again once changes_pending follows the latest reviewed', () => {
    expect(
      isCodingNeedsReview({
        task: {
          subtype: 'coding',
          commits: ['abc123'],
          history: [
            { status: 'todo', at: T0 },
            { status: 'reviewed', at: T1 },
            { status: 'changes_pending', at: T2 },
          ],
        },
      }),
    ).toBe(true);
  });

  it('false when commits empty and vcs unset', () => {
    expect(
      isCodingNeedsReview({
        task: { subtype: 'coding', commits: [], history: [{ status: 'todo', at: T0 }] },
      }),
    ).toBe(false);
  });

  it('true when vcs is none even with no commits', () => {
    expect(
      isCodingNeedsReview({
        task: {
          subtype: 'coding',
          vcs: 'none',
          commits: [],
          history: [{ status: 'in_progress', at: T0 }],
        },
      }),
    ).toBe(true);
  });

  it('false when subtype is not coding', () => {
    expect(
      isCodingNeedsReview({
        task: { commits: ['abc123'], history: [{ status: 'todo', at: T0 }] },
      }),
    ).toBe(false);
  });

  it('false when current status is done or cancelled', () => {
    expect(
      isCodingNeedsReview({
        task: {
          subtype: 'coding',
          commits: ['abc123'],
          history: [
            { status: 'todo', at: T0 },
            { status: 'done', at: T1 },
          ],
        },
      }),
    ).toBe(false);

    expect(
      isCodingNeedsReview({
        task: {
          subtype: 'coding',
          commits: ['abc123'],
          history: [
            { status: 'todo', at: T0 },
            { status: 'cancelled', at: T1 },
          ],
        },
      }),
    ).toBe(false);
  });
});
