import { describe, it, expect } from 'vitest';
import { validateTaskMetadata } from '../validate.js';

describe('validateTaskMetadata', () => {
  it('warns when type=task but task sub-section missing', () => {
    const warnings = validateTaskMetadata({ type: 'task' });
    expect(warnings).toContainEqual(
      expect.stringContaining('task metadata missing'),
    );
  });

  it('warns when task sub-section is boolean not object', () => {
    const warnings = validateTaskMetadata({ type: 'task', task: true });
    expect(warnings).toContainEqual(
      expect.stringContaining('task metadata missing'),
    );
  });

  it('warns on done status without completion_evidence', () => {
    const warnings = validateTaskMetadata({
      type: 'task',
      task: { status: 'done', priority: 'high' },
    });
    expect(warnings).toContainEqual(
      'completion_evidence recommended for done tasks',
    );
  });

  it('no warnings for valid task sub-section', () => {
    const warnings = validateTaskMetadata({
      type: 'task',
      task: { status: 'todo', priority: 'medium' },
    });
    expect(warnings).toEqual([]);
  });

  it('no warnings for done task with completion_evidence', () => {
    const warnings = validateTaskMetadata({
      type: 'task',
      task: {
        status: 'done',
        priority: 'high',
        completion_evidence: 'commit abc123',
      },
    });
    expect(warnings).toEqual([]);
  });

  it('ignores non-task entries', () => {
    expect(validateTaskMetadata({ type: 'standard' })).toEqual([]);
    expect(validateTaskMetadata({})).toEqual([]);
  });
});
