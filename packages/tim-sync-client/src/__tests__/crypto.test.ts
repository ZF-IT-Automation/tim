import { describe, it, expect } from 'vitest';
import { deriveKey, encrypt, decrypt, generateSalt } from '../crypto.js';

describe('crypto', () => {
  it('round-trips encrypt/decrypt', () => {
    const salt = generateSalt();
    const key = deriveKey('test-passphrase', salt);
    const plaintext = JSON.stringify({ v: 1, type: 'entry', key: 'abc' });
    const blob = encrypt(plaintext, key);
    expect(decrypt(blob, key)).toBe(plaintext);
  });

  it('fails decrypt with wrong key', () => {
    const salt = generateSalt();
    const key1 = deriveKey('pass-a', salt);
    const key2 = deriveKey('pass-b', salt);
    const blob = encrypt('secret', key1);
    expect(() => decrypt(blob, key2)).toThrow();
  });
});
