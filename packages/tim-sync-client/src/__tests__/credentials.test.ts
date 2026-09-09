import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MissingSecretPassphraseError,
  resolveSecretPassphrase,
} from '../credentials.js';

describe('resolveSecretPassphrase', () => {
  const orig = process.env.TIM_SECRET_PASSPHRASE;

  beforeEach(() => {
    delete process.env.TIM_SECRET_PASSPHRASE;
  });

  afterEach(() => {
    if (orig === undefined) delete process.env.TIM_SECRET_PASSPHRASE;
    else process.env.TIM_SECRET_PASSPHRASE = orig;
  });

  it('reads from TIM_SECRET_PASSPHRASE env', () => {
    process.env.TIM_SECRET_PASSPHRASE = 'from-env';
    expect(resolveSecretPassphrase()).toBe('from-env');
  });

  it('prefers CLI flag over env', () => {
    process.env.TIM_SECRET_PASSPHRASE = 'from-env';
    expect(resolveSecretPassphrase({ 'secret-passphrase': 'from-flag' })).toBe('from-flag');
  });

  it('returns undefined when unset', () => {
    expect(resolveSecretPassphrase()).toBeUndefined();
    expect(resolveSecretPassphrase({})).toBeUndefined();
  });
});

describe('MissingSecretPassphraseError', () => {
  it('names the credential source without echoing values', () => {
    const err = new MissingSecretPassphraseError(2);
    expect(err.name).toBe('MissingSecretPassphraseError');
    expect(err.blockedCount).toBe(2);
    expect(err.message).toContain('TIM_SECRET_PASSPHRASE');
    expect(err.message).toContain('--secret-passphrase');
  });
});
