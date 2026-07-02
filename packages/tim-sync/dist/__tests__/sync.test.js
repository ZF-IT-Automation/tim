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
(0, vitest_1.describe)('Deterministic LWW', () => {
    (0, vitest_1.it)('should prefer newer lwwTimestamp', () => {
        const a = makeRecord({ lwwTimestamp: 100, lwwDevice: 'aaa' });
        const b = makeRecord({ lwwTimestamp: 200, lwwDevice: 'bbb' });
        const result = (0, sync_js_1.resolveLWW)(a, b);
        (0, vitest_1.expect)(result.winner).toBe(b);
        (0, vitest_1.expect)(result.reason).toBe('newer_timestamp');
    });
    (0, vitest_1.it)('should tiebreak equal timestamps by lexicographic lwwDevice', () => {
        const ts = 5000;
        const a = makeRecord({ lwwTimestamp: ts, lwwDevice: 'aaa' });
        const b = makeRecord({ lwwTimestamp: ts, lwwDevice: 'bbb' });
        const result = (0, sync_js_1.resolveLWW)(a, b);
        (0, vitest_1.expect)(result.winner).toBe(b);
        (0, vitest_1.expect)(result.reason).toBe('only_one');
    });
    (0, vitest_1.it)('should ignore confidence weighting (older timestamp wins even with low confidence on newer)', () => {
        const a = makeRecord({ lwwTimestamp: 100, lwwConfidence: 0.1, lwwDevice: 'aaa' });
        const b = makeRecord({ lwwTimestamp: 200, lwwConfidence: 1.0, lwwDevice: 'bbb' });
        const result = (0, sync_js_1.resolveLWW)(a, b);
        (0, vitest_1.expect)(result.winner).toBe(b);
        (0, vitest_1.expect)(result.reason).toBe('newer_timestamp');
    });
    (0, vitest_1.it)('should produce identical results regardless of call time', async () => {
        const a = makeRecord({ lwwTimestamp: 1000, lwwDevice: 'device-a', lwwConfidence: 0.9 });
        const b = makeRecord({ lwwTimestamp: 1000, lwwDevice: 'device-b', lwwConfidence: 0.1 });
        const first = (0, sync_js_1.resolveLWW)(a, b);
        await new Promise(r => setTimeout(r, 50));
        const second = (0, sync_js_1.resolveLWW)(a, b);
        (0, vitest_1.expect)(first.winner).toBe(second.winner);
        (0, vitest_1.expect)(first.reason).toBe(second.reason);
    });
    (0, vitest_1.it)('should pick the same winner regardless of argument order', () => {
        const a = makeRecord({ key: 'x', lwwTimestamp: 100, lwwDevice: 'aaa' });
        const b = makeRecord({ key: 'x', lwwTimestamp: 200, lwwDevice: 'bbb' });
        (0, vitest_1.expect)((0, sync_js_1.resolveLWW)(a, b).winner).toBe((0, sync_js_1.resolveLWW)(b, a).winner);
    });
});
(0, vitest_1.describe)('mergeStaging', () => {
    (0, vitest_1.it)('should merge disjoint records', () => {
        const local = [makeRecord({ key: 'a' })];
        const remote = [makeRecord({ key: 'b' })];
        const merged = (0, sync_js_1.mergeStaging)(local, remote);
        (0, vitest_1.expect)(merged.length).toBe(2);
    });
    (0, vitest_1.it)('should resolve conflicts by timestamp', () => {
        const local = makeRecord({ key: 'x', lwwTimestamp: 100, lwwDevice: 'aaa' });
        const remote = makeRecord({ key: 'x', lwwTimestamp: 200, lwwDevice: 'bbb' });
        const merged = (0, sync_js_1.mergeStaging)([local], [remote]);
        (0, vitest_1.expect)(merged.length).toBe(1);
        (0, vitest_1.expect)(merged[0].lwwTimestamp).toBe(200);
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
    (0, vitest_1.it)('should detect conflicts and resolve by timestamp', () => {
        const local = [makeRecord({ key: 'x', lwwTimestamp: 300, lwwDevice: 'aaa' })];
        const remote = [makeRecord({ key: 'x', lwwTimestamp: 100, lwwDevice: 'bbb' })];
        const { merged, result } = (0, sync_js_1.syncCycle)(local, remote, 0);
        (0, vitest_1.expect)(merged.length).toBe(1);
        (0, vitest_1.expect)(result.conflicts).toHaveLength(1);
        (0, vitest_1.expect)(result.conflicts[0].reason).toBe('newer_timestamp');
        (0, vitest_1.expect)(merged[0].lwwTimestamp).toBe(300);
    });
    (0, vitest_1.it)('should converge when both devices merge the same conflicting writes', () => {
        const deviceA = 'device-alpha';
        const deviceB = 'device-bravo';
        const key = 'shared-entry';
        const writeA = makeRecord({
            key,
            lwwTimestamp: 1000,
            lwwDevice: deviceA,
            payload: '{"id":"shared-entry","content":"from A"}',
        });
        const writeB = makeRecord({
            key,
            lwwTimestamp: 2000,
            lwwDevice: deviceB,
            payload: '{"id":"shared-entry","content":"from B"}',
        });
        const sideA = (0, sync_js_1.mergeStaging)([writeA], [writeB]);
        const sideB = (0, sync_js_1.mergeStaging)([writeB], [writeA]);
        (0, vitest_1.expect)(sideA).toHaveLength(1);
        (0, vitest_1.expect)(sideB).toHaveLength(1);
        (0, vitest_1.expect)(sideA[0].lwwTimestamp).toBe(sideB[0].lwwTimestamp);
        (0, vitest_1.expect)(sideA[0].lwwDevice).toBe(sideB[0].lwwDevice);
        (0, vitest_1.expect)(sideA[0].payload).toBe(sideB[0].payload);
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
        (0, vitest_1.expect)(delta.length).toBe(2);
    });
    (0, vitest_1.it)('should detect sync status', () => {
        const records = [makeRecord()];
        const root = (0, sync_js_1.getMerkleRoot)(records);
        (0, vitest_1.expect)((0, sync_js_1.isInSync)(root, root)).toBe(true);
        (0, vitest_1.expect)((0, sync_js_1.isInSync)(root, 'different')).toBe(false);
    });
});
//# sourceMappingURL=sync.test.js.map