import { describe, expect, it } from 'vitest';
import {
  SYNC_PROTOCOL_GENERATION,
  classifySyncConfigValue,
  classifySyncStateValue,
} from '../sync-diagnostics.js';

const binding = {
  dbIdentity: '/tmp/tim.db',
  serverUrl: 'https://sync.example',
  tenantId: 'tenant-1',
  fileId: 'file-1',
  protocolGeneration: SYNC_PROTOCOL_GENERATION,
};

describe('sync config classification', () => {
  it('treats the all-empty placeholder as disconnected', () => {
    const result = classifySyncConfigValue({
      serverUrl: '',
      userId: '',
      token: '',
      salt: '',
      fileId: '',
    });
    expect(result.status).toBe('disconnected');
    expect(result.identity).toBeNull();
  });

  it('rejects a partial object as invalid config', () => {
    expect(classifySyncConfigValue({ serverUrl: 'https://sync.example', fileId: '' }).status)
      .toBe('invalid_config');
  });

  it('accepts a complete connection', () => {
    const result = classifySyncConfigValue({
      serverUrl: 'https://sync.example',
      userId: 'tenant-1',
      token: 'secret-token',
      salt: 'secret-salt',
      fileId: 'file-1',
    });
    expect(result.status).toBe('configured');
    expect(result.identity?.tenantId).toBe('tenant-1');
    expect(result.identity?.fileId).toBe('file-1');
  });
});

describe('sync state classification', () => {
  const bound = {
    fileId: 'file-1',
    dbIdentity: '/tmp/tim.db',
    serverUrl: 'https://sync.example',
    tenantId: 'tenant-1',
    protocolGeneration: SYNC_PROTOCOL_GENERATION,
    cursor: 'cursor-1',
    lastPush: '2026-01-01T00:00:00.000Z',
    lastPull: null,
  };

  it('withholds the cursor and success timestamps from fake-file-id legacy state', () => {
    const result = classifySyncStateValue({
      fileId: 'fake-file-id',
      cursor: 'stale',
      lastPush: '2026-08-12T00:00:00.000Z',
      lastPull: '2026-08-12T00:00:00.000Z',
    }, binding);
    expect(result.status).toBe('mismatched_file');
    expect(result.cursorUsable).toBe(false);
    expect(result.lastPushSuccess).toBeNull();
  });

  it('does not treat an unbound matching fileId as a usable cursor', () => {
    const result = classifySyncStateValue({
      fileId: 'file-1',
      cursor: 'stale',
      lastPush: '2026-08-12T00:00:00.000Z',
      lastPull: null,
    }, binding);
    expect(result.status).toBe('unbound');
    expect(result.cursorUsable).toBe(false);
    expect(result.lastPushSuccess).toBeNull();
  });

  it('rejects a database mismatch even when the file id matches', () => {
    const result = classifySyncStateValue({
      ...bound,
      dbIdentity: '/tmp/other.db',
    }, binding);
    expect(result.status).toBe('mismatched_db');
    expect(result.cursorUsable).toBe(false);
  });

  it('rejects invalid timestamps before trusting the cursor', () => {
    const result = classifySyncStateValue({
      ...bound,
      lastPush: 'yesterday',
    }, binding);
    expect(result.status).toBe('invalid_timestamp');
    expect(result.cursorUsable).toBe(false);
  });

  it('accepts a fully bound state', () => {
    const result = classifySyncStateValue(bound, binding);
    expect(result.status).toBe('available');
    expect(result.cursorUsable).toBe(true);
    expect(result.lastPushSuccess).toBe('2026-01-01T00:00:00.000Z');
  });
});
