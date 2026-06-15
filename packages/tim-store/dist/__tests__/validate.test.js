"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const validate_js_1 = require("../validate.js");
(0, vitest_1.describe)('validateTaskMetadata', () => {
    (0, vitest_1.it)('warns when type=task but task sub-section missing', () => {
        const warnings = (0, validate_js_1.validateTaskMetadata)({ type: 'task' });
        (0, vitest_1.expect)(warnings).toContainEqual(vitest_1.expect.stringContaining('task metadata missing'));
    });
    (0, vitest_1.it)('warns when task sub-section is boolean not object', () => {
        const warnings = (0, validate_js_1.validateTaskMetadata)({ type: 'task', task: true });
        (0, vitest_1.expect)(warnings).toContainEqual(vitest_1.expect.stringContaining('task metadata missing'));
    });
    (0, vitest_1.it)('warns on done status without completion_evidence', () => {
        const warnings = (0, validate_js_1.validateTaskMetadata)({
            type: 'task',
            task: { status: 'done', priority: 'high' },
        });
        (0, vitest_1.expect)(warnings).toContainEqual('completion_evidence recommended for done tasks');
    });
    (0, vitest_1.it)('no warnings for valid task sub-section', () => {
        const warnings = (0, validate_js_1.validateTaskMetadata)({
            type: 'task',
            task: { status: 'todo', priority: 'medium' },
        });
        (0, vitest_1.expect)(warnings).toEqual([]);
    });
    (0, vitest_1.it)('no warnings for done task with completion_evidence', () => {
        const warnings = (0, validate_js_1.validateTaskMetadata)({
            type: 'task',
            task: {
                status: 'done',
                priority: 'high',
                completion_evidence: 'commit abc123',
            },
        });
        (0, vitest_1.expect)(warnings).toEqual([]);
    });
    (0, vitest_1.it)('ignores non-task entries', () => {
        (0, vitest_1.expect)((0, validate_js_1.validateTaskMetadata)({ type: 'standard' })).toEqual([]);
        (0, vitest_1.expect)((0, validate_js_1.validateTaskMetadata)({})).toEqual([]);
    });
});
(0, vitest_1.describe)('validateRuleMetadata', () => {
    (0, vitest_1.it)('warns when type=rule but rule sub-section missing', () => {
        const warnings = (0, validate_js_1.validateRuleMetadata)({ type: 'rule' });
        (0, vitest_1.expect)(warnings).toContainEqual('rule metadata missing');
    });
    (0, vitest_1.it)('warns when rule sub-section is boolean not object', () => {
        const warnings = (0, validate_js_1.validateRuleMetadata)({ type: 'rule', rule: true });
        (0, vitest_1.expect)(warnings).toContainEqual('rule metadata missing');
    });
    (0, vitest_1.it)('warns when rule.trigger missing', () => {
        const warnings = (0, validate_js_1.validateRuleMetadata)({
            type: 'rule',
            rule: { action: 'Do the thing' },
        });
        (0, vitest_1.expect)(warnings).toContainEqual('trigger recommended');
    });
    (0, vitest_1.it)('warns when rule.action missing', () => {
        const warnings = (0, validate_js_1.validateRuleMetadata)({
            type: 'rule',
            rule: { trigger: 'When user asks' },
        });
        (0, vitest_1.expect)(warnings).toContainEqual('action recommended');
    });
    (0, vitest_1.it)('no warnings for valid rule sub-section', () => {
        const warnings = (0, validate_js_1.validateRuleMetadata)({
            type: 'rule',
            rule: { trigger: 'When user says caveman', action: 'Use caveman mode' },
        });
        (0, vitest_1.expect)(warnings).toEqual([]);
    });
    (0, vitest_1.it)('ignores non-rule entries', () => {
        (0, vitest_1.expect)((0, validate_js_1.validateRuleMetadata)({ type: 'standard' })).toEqual([]);
        (0, vitest_1.expect)((0, validate_js_1.validateRuleMetadata)({})).toEqual([]);
    });
});
(0, vitest_1.describe)('validateBugMetadata', () => {
    (0, vitest_1.it)('warns when type=bug but bug sub-section missing', () => {
        const warnings = (0, validate_js_1.validateBugMetadata)({ type: 'bug' });
        (0, vitest_1.expect)(warnings).toContainEqual(vitest_1.expect.stringContaining('bug metadata missing'));
    });
    (0, vitest_1.it)('warns when bug sub-section is boolean not object', () => {
        const warnings = (0, validate_js_1.validateBugMetadata)({ type: 'bug', bug: true });
        (0, vitest_1.expect)(warnings).toContainEqual(vitest_1.expect.stringContaining('bug metadata missing'));
    });
    (0, vitest_1.it)('warns when severity missing', () => {
        const warnings = (0, validate_js_1.validateBugMetadata)({
            type: 'bug',
            bug: { status: 'open' },
        });
        (0, vitest_1.expect)(warnings).toContainEqual('severity recommended');
    });
    (0, vitest_1.it)('warns when status missing', () => {
        const warnings = (0, validate_js_1.validateBugMetadata)({
            type: 'bug',
            bug: { severity: 'P1' },
        });
        (0, vitest_1.expect)(warnings).toContainEqual('status recommended');
    });
    (0, vitest_1.it)('no warnings for valid bug sub-section', () => {
        const warnings = (0, validate_js_1.validateBugMetadata)({
            type: 'bug',
            bug: { severity: 'P1', status: 'open' },
        });
        (0, vitest_1.expect)(warnings).toEqual([]);
    });
    (0, vitest_1.it)('ignores non-bug entries', () => {
        (0, vitest_1.expect)((0, validate_js_1.validateBugMetadata)({ type: 'standard' })).toEqual([]);
        (0, vitest_1.expect)((0, validate_js_1.validateBugMetadata)({})).toEqual([]);
    });
});
//# sourceMappingURL=validate.test.js.map