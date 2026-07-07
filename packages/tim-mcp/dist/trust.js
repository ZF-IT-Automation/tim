"use strict";
// Read-time trust annotations: staleness (this task) and provenance
// drift (Task 5). Annotations are additive fields on the returned entry —
// the stored row is never modified by reading it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.annotateTrust = annotateTrust;
const tim_core_1 = require("tim-core");
const provenance_js_1 = require("./provenance.js");
function annotateTrust(entry, cwd) {
    const kind = typeof entry.metadata.kind === 'string' ? entry.metadata.kind : undefined;
    if (kind && tim_core_1.SCHEMA_KINDS.has(kind))
        return entry;
    const verifiedAt = typeof entry.metadata.verified_at === 'string' ? entry.metadata.verified_at : undefined;
    const lastVerified = verifiedAt ?? entry.updatedAt ?? entry.createdAt;
    const daysSince = (0, tim_core_1.daysSinceLastVerified)(entry);
    const annotated = { ...entry };
    if ((0, tim_core_1.isStale)(entry, (0, tim_core_1.staleDays)())) {
        annotated.stale = { lastVerified, daysSince };
    }
    const prov = entry.metadata.provenance;
    if (prov && typeof prov.commit === 'string') {
        const drift = (0, provenance_js_1.commitsSinceCached)(cwd, prov.commit);
        if (drift !== null && drift > 0) {
            annotated.provenance_drift = { commitsSince: drift };
        }
    }
    return annotated.stale || annotated.provenance_drift ? annotated : entry;
}
//# sourceMappingURL=trust.js.map