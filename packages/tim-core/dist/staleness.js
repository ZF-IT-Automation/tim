"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.daysSinceLastVerified = daysSinceLastVerified;
exports.isStale = isStale;
exports.staleDays = staleDays;
const DAY_MS = 86_400_000;
function daysSinceLastVerified(entry, now = Date.now()) {
    const verifiedAt = typeof entry.metadata.verified_at === 'string'
        ? entry.metadata.verified_at : undefined;
    const lastVerified = verifiedAt ?? entry.updatedAt ?? entry.createdAt;
    return Math.floor((now - Date.parse(lastVerified)) / DAY_MS);
}
function isStale(entry, thresholdDays, now = Date.now()) {
    const daysSince = daysSinceLastVerified(entry, now);
    return Number.isFinite(daysSince) && daysSince > thresholdDays;
}
function staleDays() {
    const raw = Number(process.env.TIM_STALE_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : 90;
}
//# sourceMappingURL=staleness.js.map