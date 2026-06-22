"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const metadata_coerce_js_1 = require("../metadata-coerce.js");
(0, vitest_1.describe)('coerceMetadataBooleans', () => {
    (0, vitest_1.it)('coerces integer task to boolean true', () => {
        (0, vitest_1.expect)((0, metadata_coerce_js_1.coerceMetadataBooleans)({ task: 1, status: 'done' })).toEqual({
            task: true,
            status: 'done',
        });
    });
    (0, vitest_1.it)('coerces string "true" task to boolean true', () => {
        (0, vitest_1.expect)((0, metadata_coerce_js_1.coerceMetadataBooleans)({ task: 'true' })).toEqual({ task: true });
    });
    (0, vitest_1.it)('is idempotent for real booleans', () => {
        (0, vitest_1.expect)((0, metadata_coerce_js_1.coerceMetadataBooleans)({ task: true })).toEqual({ task: true });
    });
    (0, vitest_1.it)('coerces 0 and "false" to false', () => {
        (0, vitest_1.expect)((0, metadata_coerce_js_1.coerceMetadataBooleans)({ task: 0, archived: 'false' })).toEqual({
            task: false,
            archived: false,
        });
    });
    (0, vitest_1.it)('coerces nested objects', () => {
        (0, vitest_1.expect)((0, metadata_coerce_js_1.coerceMetadataBooleans)({ a: { task: 1, b: 2 } })).toEqual({
            a: { task: true, b: 2 },
        });
    });
    (0, vitest_1.it)('coerces booleans inside arrays', () => {
        (0, vitest_1.expect)((0, metadata_coerce_js_1.coerceMetadataBooleans)({ tasks: [{ task: 1 }, { task: 0 }] })).toEqual({
            tasks: [{ task: true }, { task: false }],
        });
    });
    (0, vitest_1.it)('passes through unknown keys unchanged', () => {
        (0, vitest_1.expect)((0, metadata_coerce_js_1.coerceMetadataBooleans)({ priority: 'high', count: 5 })).toEqual({
            priority: 'high',
            count: 5,
        });
    });
});
//# sourceMappingURL=metadata-coerce.test.js.map