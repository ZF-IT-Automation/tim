"use strict";
/**
 * Standalone metadata validation (Schema v3 Phase 2a).
 * Warnings only — no throws during migration phase.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTaskMetadata = validateTaskMetadata;
exports.validateRuleMetadata = validateRuleMetadata;
function validateTaskMetadata(metadata) {
    const warnings = [];
    if (metadata.type === 'task') {
        const task = metadata.task;
        if (!task || typeof task !== 'object' || Array.isArray(task)) {
            warnings.push('task metadata missing — recommended default: { status: "todo", priority: "medium" }');
        }
        else {
            const taskObj = task;
            if (taskObj.status === 'done' && !taskObj.completion_evidence) {
                warnings.push('completion_evidence recommended for done tasks');
            }
        }
    }
    return warnings;
}
function validateRuleMetadata(metadata) {
    const warnings = [];
    if (metadata.type === 'rule') {
        const rule = metadata.rule;
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            warnings.push('rule metadata missing');
        }
        else {
            const ruleObj = rule;
            const trigger = ruleObj.trigger;
            if (typeof trigger !== 'string' || !trigger.trim()) {
                warnings.push('trigger recommended');
            }
            const action = ruleObj.action;
            if (typeof action !== 'string' || !action.trim()) {
                warnings.push('action recommended');
            }
        }
    }
    return warnings;
}
//# sourceMappingURL=validate.js.map