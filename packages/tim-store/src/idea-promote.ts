import { isIdeaMarker, isTaskMarker } from './metadata-coerce.js';

export function isCodingNeedsReview(metadata: Record<string, unknown>): boolean {
  const task = metadata.task;
  if (typeof task !== 'object' || task === null || Array.isArray(task)) return false;
  const t = task as Record<string, unknown>;
  if (t.subtype !== 'coding') return false;
  if (t.reviewed === true) return false;
  const commits = t.commits;
  return Array.isArray(commits) && commits.length >= 1;
}

export interface PromoteResult {
  metadata: Record<string, unknown>;
  didPromote: boolean;
  error?: string;
}

export function applyIdeaPromote(
  metadata: Record<string, unknown>,
  nowIso: string = new Date().toISOString(),
): PromoteResult {
  const idea = metadata.idea;

  if (idea !== undefined && !isIdeaMarker(idea)) {
    if (idea === 'planned' || idea === true) {
      return { metadata, didPromote: false, error: 'Invalid idea marker for promote' };
    }
    return { metadata, didPromote: false };
  }

  if (!isIdeaMarker(idea)) {
    return { metadata, didPromote: false };
  }

  const ideaObj = idea as Record<string, unknown>;
  if (ideaObj.status !== 'planned') {
    return { metadata, didPromote: false };
  }

  if (isTaskMarker(metadata.task)) {
    return { metadata, didPromote: false, error: 'Cannot promote: entry is already a task' };
  }

  const next: Record<string, unknown> = { ...metadata };
  delete next.idea;

  const priorityFromIdea =
    typeof ideaObj.priority === 'string' ? ideaObj.priority : undefined;
  const priorityFromMeta =
    typeof metadata.priority === 'string' ? metadata.priority : undefined;

  const task: Record<string, unknown> = { status: 'todo' };
  if (priorityFromIdea) task.priority = priorityFromIdea;
  else if (priorityFromMeta) task.priority = priorityFromMeta;

  next.task = task;
  next.type = 'task';

  const prevProv =
    typeof metadata.provenance === 'object' && metadata.provenance !== null && !Array.isArray(metadata.provenance)
      ? (metadata.provenance as Record<string, unknown>)
      : {};
  next.provenance = { ...prevProv, promoted_from_idea_at: nowIso };

  return { metadata: next, didPromote: true };
}
