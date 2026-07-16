import { isIdeaMarker, isTaskMarker } from './metadata-coerce.js';

export interface PromoteResult {
  metadata: Record<string, unknown>;
  didPromote: boolean;
  error?: string;
}

export interface PromoteOptions {
  /**
   * When false, refuse to promote even if merged metadata contains
   * `idea.status: planned` — the entry was not an idea before the patch.
   * Omit on write (creating with planned is allowed).
   */
  hadIdeaMarker?: boolean;
}

export function applyIdeaPromote(
  metadata: Record<string, unknown>,
  nowIso: string = new Date().toISOString(),
  opts: PromoteOptions = {},
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

  if (opts.hadIdeaMarker === false) {
    return {
      metadata,
      didPromote: false,
      error: 'Cannot promote: entry is not an idea (missing metadata.idea before patch)',
    };
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

  const task: Record<string, unknown> = {
    status: 'todo',
    history: [{ status: 'todo', at: nowIso }],
  };
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
