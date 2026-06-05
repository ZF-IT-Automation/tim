import { describe, it, expect } from 'vitest';
import { coerceMetadataBooleans } from '../metadata-coerce.js';

describe('coerceMetadataBooleans', () => {
  it('coerces integer task to boolean true', () => {
    expect(coerceMetadataBooleans({ task: 1, status: 'done' })).toEqual({
      task: true,
      status: 'done',
    });
  });

  it('coerces string "true" task to boolean true', () => {
    expect(coerceMetadataBooleans({ task: 'true' })).toEqual({ task: true });
  });

  it('is idempotent for real booleans', () => {
    expect(coerceMetadataBooleans({ task: true })).toEqual({ task: true });
  });

  it('coerces 0 and "false" to false', () => {
    expect(coerceMetadataBooleans({ task: 0, archived: 'false' })).toEqual({
      task: false,
      archived: false,
    });
  });

  it('coerces nested objects', () => {
    expect(coerceMetadataBooleans({ a: { task: 1, b: 2 } })).toEqual({
      a: { task: true, b: 2 },
    });
  });

  it('coerces booleans inside arrays', () => {
    expect(coerceMetadataBooleans({ tasks: [{ task: 1 }, { task: 0 }] })).toEqual({
      tasks: [{ task: true }, { task: false }],
    });
  });

  it('passes through unknown keys unchanged', () => {
    expect(coerceMetadataBooleans({ priority: 'high', count: 5 })).toEqual({
      priority: 'high',
      count: 5,
    });
  });
});
