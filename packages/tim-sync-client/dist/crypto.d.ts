/**
 * TIM sync crypto — AES-256-GCM + scrypt key derivation (hmem pattern).
 */
export declare function deriveKey(passphrase: string, saltBase64: string): Buffer;
export declare function encrypt(plaintext: string, key: Buffer): string;
export declare function decrypt(blobBase64: string, key: Buffer): string;
export declare function generateSalt(): string;
//# sourceMappingURL=crypto.d.ts.map