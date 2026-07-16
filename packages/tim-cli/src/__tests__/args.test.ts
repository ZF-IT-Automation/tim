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

  it('does not let boolean flags consume the following positional argument', () => {
    expect(parseArgs(['--dry-run', 'archive.hmem'])).toEqual({
      flags: { 'dry-run': 'true' },
      positional: ['archive.hmem'],
    });
  });

  it('supports declared short aliases with the same value semantics', () => {
    expect(parseArgs(['-p', '/tmp/project', '-n=Project', '-h'], {
      valueOptions: new Set(['path', 'name']),
      aliases: { p: 'path', n: 'name', h: 'help' },
    })).toEqual({
      flags: { path: '/tmp/project', name: 'Project', help: 'true' },
      positional: [],
    });
  });
});
