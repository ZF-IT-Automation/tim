import type { Entry } from 'tim-core';

/**
 * When a task was last really touched: a title/body/status change (metadata.touched_at),
 * a tim_verify (metadata.verified_at), or its creation. Falls back to updatedAt for entries
 * written before touched_at existed. Reorders and bulk metadata writes do not count.
 */
export function taskLastTouch(entry: Pick<Entry, 'createdAt' | 'updatedAt' | 'metadata'>): string {
  const meta = entry.metadata ?? {};
  const touched = typeof meta.touched_at === 'string' ? meta.touched_at : entry.updatedAt;
  const verified = typeof meta.verified_at === 'string' ? meta.verified_at : '';
  const latest = [touched, verified, entry.createdAt].reduce((a, b) => (b > a ? b : a), '');
  // A clock in the future (planted on write, copied metadata, a bad client) must not keep a
  // task fresh forever; no touch can be later than now.
  const now = new Date().toISOString();
  return latest > now ? now : latest;
}
