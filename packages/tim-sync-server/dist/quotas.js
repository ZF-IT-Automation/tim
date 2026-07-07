"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TIER_QUOTAS = void 0;
exports.getQuotaLimits = getQuotaLimits;
exports.quotaExceeded = quotaExceeded;
exports.TIER_QUOTAS = {
    free: { maxEntries: 1000, maxBytes: 10 * 1024 * 1024 },
    pro: { maxEntries: null, maxBytes: null },
};
function getQuotaLimits(tier) {
    return exports.TIER_QUOTAS[tier];
}
function quotaExceeded(tier, usage, additionalEntries, additionalBytes) {
    const limits = getQuotaLimits(tier);
    if (limits.maxEntries != null) {
        const next = usage.entryCount + additionalEntries;
        if (next > limits.maxEntries) {
            return { exceeded: true, reason: `Entry quota exceeded (${limits.maxEntries} max for ${tier})` };
        }
    }
    if (limits.maxBytes != null) {
        const next = usage.totalBytes + additionalBytes;
        if (next > limits.maxBytes) {
            return { exceeded: true, reason: `Storage quota exceeded (${limits.maxBytes} bytes max for ${tier})` };
        }
    }
    return { exceeded: false };
}
//# sourceMappingURL=quotas.js.map