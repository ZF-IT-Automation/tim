"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const envelope_js_1 = require("../envelope.js");
(0, vitest_1.describe)('envelope', () => {
    (0, vitest_1.it)('converts staging row to TimEnvelope', () => {
        const env = (0, envelope_js_1.stagingToEnvelope)({
            key: '01JTEST',
            entity_type: 'entry',
            operation: 'upsert',
            payload: '{"id":"01JTEST","content":"hi"}',
            lww_timestamp: 1_700_000_000_000,
            lww_device: 'dev-1',
            lww_confidence: 0.9,
            acked: 0,
        });
        (0, vitest_1.expect)(env).toEqual({
            v: 1,
            type: 'entry',
            key: '01JTEST',
            lww: new Date(1_700_000_000_000).toISOString(),
            deleted: false,
            payload: '{"id":"01JTEST","content":"hi"}',
        });
    });
    (0, vitest_1.it)('marks delete operations', () => {
        const env = (0, envelope_js_1.stagingToEnvelope)({
            key: 'x',
            entity_type: 'entry',
            operation: 'delete',
            payload: '{}',
            lww_timestamp: Date.now(),
            lww_device: 'd',
            lww_confidence: 1,
            acked: 0,
        });
        (0, vitest_1.expect)(env.deleted).toBe(true);
    });
    (0, vitest_1.it)('round-trips envelopeToStaging', () => {
        const env = (0, envelope_js_1.stagingToEnvelope)({
            key: (0, envelope_js_1.edgeCompositeKey)('a', 'b', 'relates'),
            entity_type: 'edge',
            operation: 'upsert',
            payload: '{"id":"e1"}',
            lww_timestamp: Date.now(),
            lww_device: 'local',
            lww_confidence: 1,
            acked: 0,
        });
        const record = (0, envelope_js_1.envelopeToStaging)(env, 'remote-dev');
        (0, vitest_1.expect)(record.entityType).toBe('edge');
        (0, vitest_1.expect)(record.lwwDevice).toBe('remote-dev');
    });
});
//# sourceMappingURL=envelope.test.js.map