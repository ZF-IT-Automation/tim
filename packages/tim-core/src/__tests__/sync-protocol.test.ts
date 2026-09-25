import { expect, it } from 'vitest';
import { normalizeLwwTimestamp } from '../lww.js';
import { validProtocolBlob } from '../sync-protocol.js';
it('normalizes logical time and rejects invalid or variable-width years', () => {
  expect(normalizeLwwTimestamp('2026-01-01T01:00:00+01:00')).toBe('2026-01-01T00:00:00.000Z');
  expect(() => normalizeLwwTimestamp('invalid')).toThrow('Invalid LWW timestamp');
  expect(() => normalizeLwwTimestamp(1.5)).toThrow('Invalid LWW timestamp');
  expect(() => normalizeLwwTimestamp('+010000-01-01T00:00:00.000Z')).toThrow('year');
});
it('requires device IDs with the same lexical order in JavaScript and SQLite', () => {
  const b={proposed_id:'x',entity_key:'x',entity_type:'entry',data:'cipher',device_id:'sender',lww_device:'uuid-device',updated_at:'2026-01-01T00:00:00.000Z'};
  expect(validProtocolBlob(b)).toBe(true);
  expect(validProtocolBlob({...b,lww_device:'\u{10000}'})).toBe(false);
  expect(validProtocolBlob({...b,lww_device:'\ue000'})).toBe(false);
});
