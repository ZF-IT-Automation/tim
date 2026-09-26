import { describe, it, expect } from 'vitest';
import { stagingToEnvelope } from '../envelope.js';
import { TimStore, applyRemoteEntry } from 'tim-store';
import {
  encryptSecretPayload,
  decryptSecretPayload,
  unlockPersistedSecretEntries,
  SecretPayloadMalformedError,
  SECRET_PLACEHOLDER_TITLE,
} from '../sync.js';
import { deriveKey, encrypt, decrypt, generateSalt } from '../crypto.js';
import type { TimEnvelope } from '../envelope.js';

describe('secret envelope encryption', () => {
  const salt = generateSalt();
  const syncPass = 'sync-pass';
  const secretPass = 'secret-pass';
  const secretKey = deriveKey(secretPass, salt);
  const secretEncrypt = (s: string) => encrypt(s, secretKey);
  const secretDecrypt = (s: string) => decrypt(s, secretKey);

  const basePayload = JSON.stringify({
    id: 'SEC-001',
    parent_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    accessed_at: '2026-01-01T00:00:00.000Z',
    depth: 1,
    title: 'My secret title',
    content: 'Sensitive body text',
    content_type: 'text',
    confidence: 1,
    decay_rate: 0,
    visibility: 1,
    irrelevant: 0,
    favorite: 0,
    tombstoned_at: null,
    tags: '[]',
    metadata: JSON.stringify({ secret: true, kind: 'note' }),
  });

  it('push secret entry encrypts title/content and sets is_encrypted', () => {
    const env = stagingToEnvelope({
      key: 'SEC-001',
      entity_type: 'entry',
      operation: 'upsert',
      payload: basePayload,
      lww_timestamp: Date.now(),
      lww_device: 'dev',
      lww_confidence: 1,
      acked: 0,
    });

    const encryptedPayload = encryptSecretPayload(env.payload, secretEncrypt);
    const parsed = JSON.parse(encryptedPayload);

    expect(parsed.title).not.toBe('My secret title');
    expect(parsed.content).not.toBe('Sensitive body text');
    expect(parsed.id).toBe('SEC-001');
    expect(parsed.parent_id).toBeNull();
    expect(parsed.depth).toBe(1);
    expect(parsed.content_type).toBe('text');
    expect(parsed.accessed_at).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.tags).toBe('[]');
    expect(JSON.parse(parsed.metadata).secret).toBe(true);
    expect(JSON.parse(parsed.metadata)._enc_v).toBe(2);
    expect(encryptedPayload).not.toContain('My secret title');
    expect(encryptedPayload).not.toContain('Sensitive body text');
    expect(encryptedPayload).not.toContain('kind');

    const wire: TimEnvelope = { ...env, payload: encryptedPayload, is_encrypted: true };
    expect(wire.is_encrypted).toBe(true);
  });

  it('round-trip pull WITH secret key restores plaintext', () => {
    const encryptedPayload = encryptSecretPayload(basePayload, secretEncrypt);
    const restored = decryptSecretPayload(encryptedPayload, secretDecrypt);
    const parsed = JSON.parse(restored);

    expect(parsed.title).toBe('My secret title');
    expect(parsed.content).toBe('Sensitive body text');
    expect(parsed.content_type).toBe('text');
    expect(parsed.accessed_at).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.tags).toBe('[]');
    const meta = JSON.parse(parsed.metadata);
    expect(meta.secret).toBe(true);
    expect(meta.kind).toBe('note');
  });

  it('pull WITHOUT secret key yields placeholder and retains secret marker', () => {
    const encryptedPayload = encryptSecretPayload(basePayload, secretEncrypt);
    const placeholder = decryptSecretPayload(encryptedPayload);
    const parsed = JSON.parse(placeholder);

    expect(parsed.title).toBe('🔒 [secret]');
    expect(parsed.content).toBe('');
    const meta = JSON.parse(parsed.metadata);
    expect(meta.secret).toBe(true);
    expect(meta._enc).toBeDefined();
  });

  it('reads v1 as encrypted migration input and never treats its fields as plaintext', () => {
    const legacy = JSON.stringify({
      ...JSON.parse(basePayload),
      title: secretEncrypt('My secret title'),
      content: secretEncrypt('Sensitive body text'),
      metadata: JSON.stringify({ secret: true, _enc: secretEncrypt(JSON.stringify({ secret: true, kind: 'note' })) }),
      tags: '["#legacy-private"]',
    });
    const locked = JSON.parse(decryptSecretPayload(legacy));
    expect(locked.title).toBe('🔒 [secret]');
    expect(locked.tags).toBe('[]');
    const restored = JSON.parse(decryptSecretPayload(legacy, secretDecrypt));
    expect(restored.title).toBe('My secret title');
    expect(restored.tags).toBe('["#legacy-private"]');
  });

  it('unlocks a v1 shell persisted without a secret key', () => {
    const legacy = JSON.stringify({
      ...JSON.parse(basePayload),
      title: secretEncrypt('My secret title'),
      content: secretEncrypt('Sensitive body text'),
      metadata: JSON.stringify({ secret: true, _enc: secretEncrypt(JSON.stringify({ secret: true, kind: 'note' })) }),
    });
    const locked = decryptSecretPayload(legacy);
    const lockMeta = JSON.parse(JSON.parse(locked).metadata);
    expect(lockMeta._enc_title).toBeDefined();
    expect(lockMeta._enc_content).toBeDefined();
    expect(JSON.parse(decryptSecretPayload(locked, secretDecrypt)).content).toBe('Sensitive body text');
  });

  it('keeps v1 ciphertext already retained by a keyless relay', () => {
    const titleCiphertext = secretEncrypt('My secret title');
    const contentCiphertext = secretEncrypt('Sensitive body text');
    const legacy = JSON.stringify({
      ...JSON.parse(basePayload),
      title: SECRET_PLACEHOLDER_TITLE,
      content: '',
      metadata: JSON.stringify({
        secret: true,
        _enc: secretEncrypt(JSON.stringify({ secret: true, kind: 'note' })),
        _enc_title: titleCiphertext,
        _enc_content: contentCiphertext,
      }),
    });
    const relayed = JSON.parse(decryptSecretPayload(legacy));
    const lock = JSON.parse(relayed.metadata);
    expect(lock._enc_title).toBe(titleCiphertext);
    expect(lock._enc_content).toBe(contentCiphertext);
    expect(JSON.parse(decryptSecretPayload(JSON.stringify(relayed), secretDecrypt)).content).toBe('Sensitive body text');
  });

  it('unlocks later valid rows when corrupt locked row comes first', () => {
    const store = new TimStore(':memory:');
    const valid = encryptSecretPayload(basePayload, secretEncrypt);
    const corrupt = JSON.parse(valid) as Record<string, unknown>;
    corrupt.id = 'CORRUPT-FIRST';
    corrupt.metadata = JSON.stringify({ secret: true, _enc_v: 2, _enc: 'not-ciphertext' });
    corrupt.metadata_raw = corrupt.metadata;
    applyRemoteEntry(store.getDb(), JSON.stringify(corrupt), 1, 'remote', false);
    applyRemoteEntry(store.getDb(), valid, 2, 'remote', false);

    const result = unlockPersistedSecretEntries(store, secretDecrypt);
    expect(result).toMatchObject({ unlocked: 1, skipped: 1, skippedIds: ['CORRUPT-FIRST'] });
    expect(store.getDb().prepare('SELECT title FROM entries WHERE id=?').get('SEC-001')).toMatchObject({ title: 'My secret title' });
    store.close();
  });

  it('rejects v2 ciphertext copied to a different entry id', () => {
    const copied = JSON.parse(encryptSecretPayload(basePayload, secretEncrypt));
    copied.id = 'SEC-OTHER';
    expect(() => decryptSecretPayload(JSON.stringify(copied), secretDecrypt)).toThrow(SecretPayloadMalformedError);
  });
});
