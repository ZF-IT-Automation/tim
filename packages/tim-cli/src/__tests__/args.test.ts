import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';

describe('parseArgs', () => {
  it('supports equals syntax and boolean flags', () => {
    expect(parseArgs(['--name=value', '--dry-run'])).toEqual({
      flags: { name: 'value', 'dry-run': 'true' },
      positional: [],
    });
  });

  it('treats arguments after the terminator as positional', () => {
    expect(parseArgs(['--', '--literal', 'x'])).toEqual({
      flags: {},
      positional: ['--literal', 'x'],
    });
  });

  it('allows an explicit value option to consume a value beginning with --', () => {
    expect(parseArgs(['--name', '--value'], { valueOptions: new Set(['name']) })).toEqual({
      flags: { name: '--value' },
      positional: [],
    });
  });
});
