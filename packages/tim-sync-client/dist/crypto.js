"use strict";
/**
 * TIM sync crypto — AES-256-GCM + scrypt key derivation (hmem pattern).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveKey = deriveKey;
exports.encrypt = encrypt;
exports.decrypt = decrypt;
exports.generateSalt = generateSalt;
const node_crypto_1 = require("node:crypto");
const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
function deriveKey(passphrase, saltBase64) {
    const salt = Buffer.from(saltBase64, 'base64');
    return (0, node_crypto_1.scryptSync)(passphrase, salt, KEY_LEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
    });
}
function encrypt(plaintext, key) {
    const iv = (0, node_crypto_1.randomBytes)(IV_LEN);
    const cipher = (0, node_crypto_1.createCipheriv)(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]).toString('base64');
}
function decrypt(blobBase64, key) {
    const buf = Buffer.from(blobBase64, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) {
        throw new Error('Invalid encrypted blob — too short.');
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN);
    const decipher = (0, node_crypto_1.createDecipheriv)(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
function generateSalt() {
    return (0, node_crypto_1.randomBytes)(SALT_LEN).toString('base64');
}
//# sourceMappingURL=crypto.js.map