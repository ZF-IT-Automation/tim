import { describe, it, expect } from 'vitest';
import {
  validateTaskMetadata,
  validateRuleMetadata,
  validateBugMetadata,
  validateIdeaMetadata,
} from '../validate.js';

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

  describe('coding subtype', () => {
    it('warns when coding task done without reviewed=true', () => {
      const warnings = validateTaskMetadata({
        type: 'task',
        task: {
          subtype: 'coding',
          status: 'done',
          completion_evidence: 'shipped',
        },
      });
      expect(warnings).toContainEqual(
        'reviewed=true recommended before marking coding tasks done',
      );
    });

    it('warns when coding task done without commits', () => {
      const warnings = validateTaskMetadata({
        type: 'task',
        task: {
          subtype: 'coding',
          status: 'done',
          reviewed: true,
          completion_evidence: 'shipped',
        },
      });
      expect(warnings).toContainEqual('commits recommended for done coding tasks');
    });

    it('no coding warnings for valid done coding task', () => {
      const warnings = validateTaskMetadata({
        type: 'task',
        task: {
          subtype: 'coding',
          status: 'done',
          reviewed: true,
          commits: ['abc123'],
          completion_evidence: 'shipped',
        },
      });
      expect(warnings).toEqual([]);
    });

    it('warns when commits/reviewed set on non-coding task', () => {
      const warnings = validateTaskMetadata({
        type: 'task',
        task: { status: 'todo', commits: ['abc'], reviewed: true },
      });
      expect(warnings).toContainEqual('commits/reviewed are for subtype=coding');
    });

    it('warns when changes_pending on non-coding task', () => {
      const warnings = validateTaskMetadata({
        type: 'task',
        task: { status: 'changes_pending' },
      });
      expect(warnings).toContainEqual(
        'changes_pending is intended for subtype=coding',
      );
    });
  });
});

describe('validateRuleMetadata', () => {
  it('warns when type=rule but rule sub-section missing', () => {
    const warnings = validateRuleMetadata({ type: 'rule' });
    expect(warnings).toContainEqual('rule metadata missing');
  });

  it('warns when rule sub-section is boolean not object', () => {
    const warnings = validateRuleMetadata({ type: 'rule', rule: true });
    expect(warnings).toContainEqual('rule metadata missing');
  });

  it('warns when rule.trigger missing', () => {
    const warnings = validateRuleMetadata({
      type: 'rule',
      rule: { action: 'Do the thing' },
    });
    expect(warnings).toContainEqual('trigger recommended');
  });

  it('warns when rule.action missing', () => {
    const warnings = validateRuleMetadata({
      type: 'rule',
      rule: { trigger: 'When user asks' },
    });
    expect(warnings).toContainEqual('action recommended');
  });

  it('no warnings for valid rule sub-section', () => {
    const warnings = validateRuleMetadata({
      type: 'rule',
      rule: { trigger: 'When user says caveman', action: 'Use caveman mode' },
    });
    expect(warnings).toEqual([]);
  });

  it('ignores non-rule entries', () => {
    expect(validateRuleMetadata({ type: 'standard' })).toEqual([]);
    expect(validateRuleMetadata({})).toEqual([]);
  });
});

describe('validateIdeaMetadata', () => {
  it('warns when type=idea but idea sub-section missing', () => {
    const warnings = validateIdeaMetadata({ type: 'idea' });
    expect(warnings).toContainEqual(expect.stringContaining('idea metadata missing'));
  });

  it('warns when idea sub-section is boolean not object', () => {
    const warnings = validateIdeaMetadata({ type: 'idea', idea: true });
    expect(warnings).toContainEqual(expect.stringContaining('idea metadata missing'));
  });

  it('no warnings for valid idea sub-section', () => {
    const warnings = validateIdeaMetadata({
      type: 'idea',
      idea: { status: 'new' },
    });
    expect(warnings).toEqual([]);
  });

  it('ignores non-idea entries', () => {
    expect(validateIdeaMetadata({ type: 'standard' })).toEqual([]);
    expect(validateIdeaMetadata({})).toEqual([]);
  });
});

describe('validateBugMetadata', () => {
  it('warns when type=bug but bug sub-section missing', () => {
    const warnings = validateBugMetadata({ type: 'bug' });
    expect(warnings).toContainEqual(
      expect.stringContaining('bug metadata missing'),
    );
  });

  it('warns when bug sub-section is boolean not object', () => {
    const warnings = validateBugMetadata({ type: 'bug', bug: true });
    expect(warnings).toContainEqual(
      expect.stringContaining('bug metadata missing'),
    );
  });

  it('warns when severity missing', () => {
    const warnings = validateBugMetadata({
      type: 'bug',
      bug: { status: 'open' },
    });
    expect(warnings).toContainEqual('severity recommended');
  });

  it('warns when status missing', () => {
    const warnings = validateBugMetadata({
      type: 'bug',
      bug: { severity: 'P1' },
    });
    expect(warnings).toContainEqual('status recommended');
  });

  it('no warnings for valid bug sub-section', () => {
    const warnings = validateBugMetadata({
      type: 'bug',
      bug: { severity: 'P1', status: 'open' },
    });
    expect(warnings).toEqual([]);
  });

  it('ignores non-bug entries', () => {
    expect(validateBugMetadata({ type: 'standard' })).toEqual([]);
    expect(validateBugMetadata({})).toEqual([]);
  });
});
