import { describe, it, expect } from 'vitest';
import { validateTaskMetadata, validateRuleMetadata, validateBugMetadata } from '../validate.js';

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
