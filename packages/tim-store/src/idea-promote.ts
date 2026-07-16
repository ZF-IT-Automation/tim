export function isCodingNeedsReview(metadata: Record<string, unknown>): boolean {
  const task = metadata.task;
  if (typeof task !== 'object' || task === null || Array.isArray(task)) return false;
  const t = task as Record<string, unknown>;
  if (t.subtype !== 'coding') return false;
  if (t.reviewed === true) return false;
  const commits = t.commits;
  return Array.isArray(commits) && commits.length >= 1;
}
