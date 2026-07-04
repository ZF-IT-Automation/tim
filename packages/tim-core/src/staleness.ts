import type { Entry } from './index.js';

const DAY_MS = 86_400_000;

export function daysSinceLastVerified(
  entry: Entry,
  now: number = Date.now(),
): number {
  const verifiedAt = typeof entry.metadata.verified_at === 'string'
    ? entry.metadata.verified_at : undefined;
  const lastVerified = verifiedAt ?? entry.updatedAt ?? entry.createdAt;
  return Math.floor((now - Date.parse(lastVerified)) / DAY_MS);
}

export function isStale(
  entry: Entry,
  thresholdDays: number,
  now: number = Date.now(),
): boolean {
  const daysSince = daysSinceLastVerified(entry, now);
  return Number.isFinite(daysSince) && daysSince > thresholdDays;
}

export function staleDays(): number {
  const raw = Number(process.env.TIM_STALE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}
