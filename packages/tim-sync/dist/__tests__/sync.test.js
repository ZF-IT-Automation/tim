"use strict";
// TIM Sync Tests — v0.1.0-alpha
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sync_js_1 = require("../sync.js");
function makeRecord(overrides = {}) {
    return {
        key: overrides.key ?? 'entry-1',
        entityType: overrides.entityType ?? 'entry',
        operation: overrides.operation ?? 'upsert',
        payload: overrides.payload ?? '{"id":"1","content":"test"}',
        lwwTimestamp: overrides.lwwTimestamp ?? Date.now(),
        lwwDevice: overrides.lwwDevice ?? 'device-a',
        lwwConfidence: overrides.lwwConfidence ?? 1.0,
        acked: overrides.acked ?? false,
    };
}
(0, vitest_1.describe)('Merkle Tree', () => {
    (0, vitest_1.it)('should return null for empty records', () => {
        (0, vitest_1.expect)((0, sync_js_1.buildMerkleTree)([])).toBeNull();
        (0, vitest_1.expect)((0, sync_js_1.getMerkleRoot)([])).toBeNull();
    });
    (0, vitest_1.it)('should produce a deterministic root', () => {
        const records = [makeRecord({ key: 'a' }), makeRecord({ key: 'b' })];
        const root1 = (0, sync_js_1.getMerkleRoot)(records);
        const root2 = (0, sync_js_1.getMerkleRoot)(records);
        (0, vitest_1.expect)(root1).toBe(root2);
    });
    (0, vitest_1.it)('should produce different roots for different records', () => {
        const a = [makeRecord({ key: 'a' })];
        const b = [makeRecord({ key: 'b' })];
        (0, vitest_1.expect)((0, sync_js_1.getMerkleRoot)(a)).not.toBe((0, sync_js_1.getMerkleRoot)(b));
    });
    (0, vitest_1.it)('should handle odd number of records', () => {
        const records = [makeRecord(), makeRecord(), makeRecord()];
        const root = (0, sync_js_1.getMerkleRoot)(records);
        (0, vitest_1.expect)(root).toBeTruthy();
        (0, vitest_1.expect)(root).toHaveLength(64); // SHA-256 hex
    });
});
(0, vitest_1.describe)('Confidence-Weighted LWW', () => {
    (0, vitest_1.it)('should prefer higher confidence with same timestamp', () => {
        const now = Date.now();
        const a = makeRecord({ lwwTimestamp: now, lwwConfidence: 0.5 });
        const b = makeRecord({ lwwTimestamp: now, lwwConfidence: 0.9 });
        const result = (0, sync_js_1.resolveLWW)(a, b);
        (0, vitest_1.expect)(result.winner).toBe(b);
        (0, vitest_1.expect)(result.reason).toBe('higher_confidence');
    });
    (0, vitest_1.it)('should prefer newer timestamp with same confidence', () => {
        const a = makeRecord({ lwwTimestamp: 1000, lwwConfidence: 1.0 });
        const b = makeRecord({ lwwTimestamp: 2000, lwwConfidence: 1.0 });
        const result = (0, sync_js_1.resolveLWW)(a, b);
        (0, vitest_1.expect)(result.winner).toBe(b);
        (0, vitest_1.expect)(result.reason).toBe('newer_timestamp');
    });
    (0, vitest_1.it)('should prefer higher confidence over newer timestamp when confidence gap is large', () => {
        const now = Date.now();
        const a = makeRecord({ lwwTimestamp: now, lwwConfidence: 0.9 });
        const b = makeRecord({ lwwTimestamp: now + 1000, lwwConfidence: 0.1 });
        const result = (0, sync_js_1.resolveLWW)(a, b);
        (0, vitest_1.expect)(result.winner).toBe(a);
        (0, vitest_1.expect)(result.reason).toBe('higher_confidence');
    });
});
(0, vitest_1.describe)('mergeStaging', () => {
    (0, vitest_1.it)('should merge disjoint records', () => {
        const local = [makeRecord({ key: 'a' })];
        const remote = [makeRecord({ key: 'b' })];
        const merged = (0, sync_js_1.mergeStaging)(local, remote);
        (0, vitest_1.expect)(merged.length).toBe(2);
    });
    (0, vitest_1.it)('should resolve conflicts', () => {
        const now = Date.now();
        const local = makeRecord({ key: 'x', lwwTimestamp: now, lwwConfidence: 0.9 });
        const remote = makeRecord({ key: 'x', lwwTimestamp: now, lwwConfidence: 0.1 });
        const merged = (0, sync_js_1.mergeStaging)([local], [remote]);
        (0, vitest_1.expect)(merged.length).toBe(1);
        (0, vitest_1.expect)(merged[0].lwwConfidence).toBe(0.9);
    });
});
(0, vitest_1.describe)('syncCycle', () => {
    (0, vitest_1.it)('should produce merged records', () => {
        const local = [makeRecord({ key: 'a' })];
        const remote = [makeRecord({ key: 'b' })];
        const { merged, result } = (0, sync_js_1.syncCycle)(local, remote, 0);
        (0, vitest_1.expect)(merged.length).toBe(2);
        (0, vitest_1.expect)(result.pushed).toBe(1);
        (0, vitest_1.expect)(result.pulled).toBe(1);
        (0, vitest_1.expect)(result.conflicts).toHaveLength(0);
        (0, vitest_1.expect)(result.merkleRoot).toBeTruthy();
    });
    (0, vitest_1.it)('should detect conflicts', () => {
        const local = [makeRecord({ key: 'x', lwwConfidence: 0.9 })];
        const remote = [makeRecord({ key: 'x', lwwConfidence: 0.3 })];
        const { merged, result } = (0, sync_js_1.syncCycle)(local, remote, 0);
        (0, vitest_1.expect)(merged.length).toBe(1);
        (0, vitest_1.expect)(result.conflicts).toHaveLength(1);
        (0, vitest_1.expect)(result.conflicts[0].reason).toBe('higher_confidence');
    });
});
(0, vitest_1.describe)('delta detection', () => {
    (0, vitest_1.it)('should compute delta from cursor', () => {
        const records = [
            makeRecord({ key: 'a', lwwTimestamp: 1000 }),
            makeRecord({ key: 'b', lwwTimestamp: 2000 }),
            makeRecord({ key: 'c', lwwTimestamp: 3000 }),
        ];
        const { records: delta } = (0, sync_js_1.computeDelta)(records, 1500);
        // Filter works on lwwTimestamp > cursor
        (0, vitest_1.expect)(delta.length).toBe(2); // b and c
    });
    (0, vitest_1.it)('should detect sync status', () => {
        const records = [makeRecord()];
        const root = (0, sync_js_1.getMerkleRoot)(records);
        (0, vitest_1.expect)((0, sync_js_1.isInSync)(root, root)).toBe(true);
        (0, vitest_1.expect)((0, sync_js_1.isInSync)(root, 'different')).toBe(false);
    });
});
//# sourceMappingURL=sync.test.js.map