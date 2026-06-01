"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const crypto_js_1 = require("../crypto.js");
(0, vitest_1.describe)('crypto', () => {
    (0, vitest_1.it)('round-trips encrypt/decrypt', () => {
        const salt = (0, crypto_js_1.generateSalt)();
        const key = (0, crypto_js_1.deriveKey)('test-passphrase', salt);
        const plaintext = JSON.stringify({ v: 1, type: 'entry', key: 'abc' });
        const blob = (0, crypto_js_1.encrypt)(plaintext, key);
        (0, vitest_1.expect)((0, crypto_js_1.decrypt)(blob, key)).toBe(plaintext);
    });
    (0, vitest_1.it)('fails decrypt with wrong key', () => {
        const salt = (0, crypto_js_1.generateSalt)();
        const key1 = (0, crypto_js_1.deriveKey)('pass-a', salt);
        const key2 = (0, crypto_js_1.deriveKey)('pass-b', salt);
        const blob = (0, crypto_js_1.encrypt)('secret', key1);
        (0, vitest_1.expect)(() => (0, crypto_js_1.decrypt)(blob, key2)).toThrow();
    });
});
//# sourceMappingURL=crypto.test.js.map