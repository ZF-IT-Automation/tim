import { describe, it, expect } from 'vitest';
import { stagingToEnvelope, envelopeToStaging, edgeCompositeKey } from '../envelope.js';

describe('envelope', () => {
  it('converts staging row to TimEnvelope', () => {
    const env = stagingToEnvelope({
      key: '01JTEST',
      entity_type: 'entry',
      operation: 'upsert',
      payload: '{"id":"01JTEST","content":"hi"}',
      lww_timestamp: 1_700_000_000_000,
      lww_device: 'dev-1',
      lww_confidence: 0.9,
      acked: 0,
    });
    expect(env).toEqual({
      v: 1,
      type: 'entry',
      key: '01JTEST',
      lww: new Date(1_700_000_000_000).toISOString(),
      deleted: false,
      payload: '{"id":"01JTEST","content":"hi"}',
      device: 'dev-1',
    });
  });

  it('marks delete operations', () => {
    const env = stagingToEnvelope({
      key: 'x',
      entity_type: 'entry',
      operation: 'delete',
      payload: '{}',
      lww_timestamp: Date.now(),
      lww_device: 'd',
      lww_confidence: 1,
      acked: 0,
    });
    expect(env.deleted).toBe(true);
  });

  it('round-trips envelopeToStaging', () => {
    const env = stagingToEnvelope({
      key: edgeCompositeKey('a', 'b', 'relates'),
      entity_type: 'edge',
      operation: 'upsert',
      payload: '{"id":"e1"}',
      lww_timestamp: Date.now(),
      lww_device: 'local',
      lww_confidence: 1,
      acked: 0,
    });
    const record = envelopeToStaging(env, 'remote-dev');
    expect(record.entityType).toBe('edge');
    // Origin device survives the round-trip — LWW tiebreaks on the true
    // origin, not the receiving device.
    expect(record.lwwDevice).toBe('local');
  });

  it('falls back to the receiver id for legacy envelopes without device', () => {
    const record = envelopeToStaging({
      v: 1,
      type: 'entry',
      key: 'k',
      lww: new Date().toISOString(),
      deleted: false,
      payload: '{}',
    }, 'remote-dev');
    expect(record.lwwDevice).toBe('remote-dev');
  });
});
