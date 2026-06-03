import { describe, it, expect } from 'vitest';
import { evaluateLoadGate } from '../load-gate.js';

describe('evaluateLoadGate', () => {
  it('allows first bind when ref undefined', () => {
    expect(evaluateLoadGate(undefined, 'P0062')).toBe('bind');
  });

  it('allows first bind when ref null', () => {
    expect(evaluateLoadGate(null, 'P0062')).toBe('bind');
  });

  it('allows first bind when ref empty string', () => {
    expect(evaluateLoadGate('', 'P0062')).toBe('bind');
  });

  it('allows bind from P0000 Inbox (unbound)', () => {
    expect(evaluateLoadGate('P0000', 'P0062')).toBe('bind');
  });

  it('allows same-project refresh', () => {
    expect(evaluateLoadGate('P0062', 'P0062')).toBe('bind');
  });

  it('rejects different project', () => {
    expect(evaluateLoadGate('P0063', 'P0062')).toBe('reject');
  });
});
