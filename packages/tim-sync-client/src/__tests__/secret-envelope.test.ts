import { describe, it, expect } from 'vitest';
import { stagingToEnvelope } from '../envelope.js';
import {
  encryptSecretPayload,
  decryptSecretPayload,
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
    depth: 1,
    title: 'My secret title',
    content: 'Sensitive body text',
    content_type: 'text',
    confidence: 1,
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
    expect(JSON.parse(parsed.metadata).secret).toBe(true);

    const wire: TimEnvelope = { ...env, payload: encryptedPayload, is_encrypted: true };
    expect(wire.is_encrypted).toBe(true);
  });

  it('round-trip pull WITH secret key restores plaintext', () => {
    const encryptedPayload = encryptSecretPayload(basePayload, secretEncrypt);
    const restored = decryptSecretPayload(encryptedPayload, secretDecrypt);
    const parsed = JSON.parse(restored);

    expect(parsed.title).toBe('My secret title');
    expect(parsed.content).toBe('Sensitive body text');
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
});
