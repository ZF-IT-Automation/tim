import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { snapshotFootprintBytes } from '../snapshot.js';

describe('snapshotFootprintBytes WAL stat injection', () => {
  it('propagates non-ENOENT WAL stat failures', () => {
    expect(() =>
      snapshotFootprintBytes('/tmp/tim-footprint-inject.db', {
        statDb: () => ({ size: 100 }),
        statWal: () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      }),
    ).toThrow();
  });

  it('adds WAL bytes when statWal succeeds', () => {
    const result = snapshotFootprintBytes('/tmp/x.db', {
      statDb: () => ({ size: 100 }),
      statWal: () => ({ size: 400 }),
    });
    expect(result).toBe(500);
  });

  it('ignores ENOENT on WAL', () => {
    const result = snapshotFootprintBytes('/tmp/x.db', {
      statDb: () => ({ size: 100 }),
      statWal: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(result).toBe(100);
  });
});
