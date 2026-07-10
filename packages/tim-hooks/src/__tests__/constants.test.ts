import { describe, it, expect } from 'vitest';
import { DEFAULT_SUMMARIZER_TIMEOUT_SEC, LOCK_TTL_MS } from '../constants.js';

describe('summarizer timing constants', () => {
  it('lock TTL exceeds summarizer timeout (regression)', () => {
    expect(LOCK_TTL_MS).toBeGreaterThan(DEFAULT_SUMMARIZER_TIMEOUT_SEC * 1000);
  });
});
