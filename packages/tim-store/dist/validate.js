"use strict";
/**
 * Standalone metadata validation (Schema v3 Phase 2a).
 * Warnings only — no throws during migration phase.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTaskMetadata = validateTaskMetadata;
exports.validateRuleMetadata = validateRuleMetadata;
exports.validateIdeaMetadata = validateIdeaMetadata;
exports.validateBugMetadata = validateBugMetadata;
exports.validateTagsDeprecated = validateTagsDeprecated;
const tim_core_1 = require("tim-core");
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
            if (taskObj.subtype === 'coding') {
                if (taskObj.status === 'done' && taskObj.reviewed !== true) {
                    warnings.push('reviewed=true recommended before marking coding tasks done');
                }
                if (taskObj.status === 'done' &&
                    (!Array.isArray(taskObj.commits) || taskObj.commits.length === 0)) {
                    warnings.push('commits recommended for done coding tasks');
                }
            }
            else {
                if (taskObj.commits !== undefined || taskObj.reviewed !== undefined) {
                    warnings.push('commits/reviewed are for subtype=coding');
                }
                if (taskObj.status === 'changes_pending') {
                    warnings.push('changes_pending is intended for subtype=coding');
                }
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
function validateIdeaMetadata(metadata) {
    const warnings = [];
    if (metadata.type === 'idea') {
        const idea = metadata.idea;
        if (!idea || typeof idea !== 'object' || Array.isArray(idea)) {
            warnings.push('idea metadata missing');
        }
    }
    return warnings;
}
function validateBugMetadata(metadata) {
    const warnings = [];
    if (metadata.type === 'bug') {
        const bug = metadata.bug;
        if (!bug || typeof bug !== 'object' || Array.isArray(bug)) {
            warnings.push('bug metadata missing — recommended default: { severity: "P1", status: "open" }');
        }
        else {
            const bugObj = bug;
            if (!bugObj.severity) {
                warnings.push('severity recommended');
            }
            if (!bugObj.status) {
                warnings.push('status recommended');
            }
        }
    }
    return warnings;
}
function validateTagsDeprecated(tags) {
    const warnings = [];
    for (const tag of tags) {
        if ((0, tim_core_1.isDeprecatedTag)(tag)) {
            warnings.push(`Deprecated tag '${tag}': use metadata.task.status / metadata.task.priority instead. Tag will not be written.`);
        }
    }
    return warnings;
}
//# sourceMappingURL=validate.js.map