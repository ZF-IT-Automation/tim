"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const entry_id_js_1 = require("../entry-id.js");
(0, vitest_1.describe)('formatEntryId', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('uses ns when no session in metadata', () => {
        vitest_1.vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-06-01T12:00:00.000Z');
        const id = (0, entry_id_js_1.formatEntryId)({ device: 'ubun', metadata: {} });
        (0, vitest_1.expect)(id).toMatch(/^ubun-0601-ns-[0-9A-Z]{26}$/);
    });
    (0, vitest_1.it)('embeds session_short from metadata.sessionId', () => {
        vitest_1.vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-06-01T12:00:00.000Z');
        const id = (0, entry_id_js_1.formatEntryId)({
            device: 'ubun',
            metadata: { sessionId: 'abc123-session-uuid' },
        });
        (0, vitest_1.expect)(id).toMatch(/^ubun-0601-abc123-[0-9A-Z]{26}$/);
        (0, vitest_1.expect)((0, entry_id_js_1.sessionShortFromMetadata)({ sessionId: 'abc123-session-uuid' })).toBe('abc123');
    });
    (0, vitest_1.it)('accepts metadata.session_id alias', () => {
        (0, vitest_1.expect)((0, entry_id_js_1.sessionShortFromMetadata)({ session_id: 'sess99' })).toBe('sess99');
    });
});
//# sourceMappingURL=entry-id.test.js.map