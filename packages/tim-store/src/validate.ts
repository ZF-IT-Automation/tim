/**
 * Standalone metadata validation (Schema v3 Phase 2a).
 * Warnings only — no throws during migration phase.
 */

import { isDeprecatedTag } from 'tim-core';

export function validateTaskMetadata(metadata: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (metadata.type === 'task') {
    const task = metadata.task;
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      warnings.push(
        'task metadata missing — recommended default: { status: "todo", priority: "medium" }',
      );
    } else {
      const taskObj = task as Record<string, unknown>;
      if (taskObj.status === 'done' && !taskObj.completion_evidence) {
        warnings.push('completion_evidence recommended for done tasks');
      }
      if (taskObj.subtype === 'coding') {
        if (taskObj.status === 'done' && taskObj.reviewed !== true) {
          warnings.push('reviewed=true recommended before marking coding tasks done');
        }
        if (
          taskObj.status === 'done' &&
          (!Array.isArray(taskObj.commits) || taskObj.commits.length === 0)
        ) {
          warnings.push('commits recommended for done coding tasks');
        }
      } else {
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

export function validateRuleMetadata(metadata: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (metadata.type === 'rule') {
    const rule = metadata.rule;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      warnings.push('rule metadata missing');
    } else {
      const ruleObj = rule as Record<string, unknown>;
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

export function validateIdeaMetadata(metadata: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (metadata.type === 'idea') {
    const idea = metadata.idea;
    if (!idea || typeof idea !== 'object' || Array.isArray(idea)) {
      warnings.push('idea metadata missing');
    }
  }

  return warnings;
}

export function validateBugMetadata(metadata: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (metadata.type === 'bug') {
    const bug = metadata.bug;
    if (!bug || typeof bug !== 'object' || Array.isArray(bug)) {
      warnings.push(
        'bug metadata missing — recommended default: { severity: "P1", status: "open" }',
      );
    } else {
      const bugObj = bug as Record<string, unknown>;
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

export function validateTagsDeprecated(tags: string[]): string[] {
  const warnings: string[] = [];
  for (const tag of tags) {
    if (isDeprecatedTag(tag)) {
      warnings.push(
        `Deprecated tag '${tag}': use metadata.task.status / metadata.task.priority instead. Tag will not be written.`,
      );
    }
  }
  return warnings;
}
