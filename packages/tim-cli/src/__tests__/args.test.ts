import { describe, expect, it } from 'vitest';
import { hasBooleanFlag, parseArgs, valueOptionsFor } from '../args.js';

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

  it('reports a declared value option that has no following token', () => {
    expect(() => parseArgs(['--name'], { valueOptions: new Set(['name']) }))
      .toThrow('Missing value for --name');
  });

  it('finds help in order without validating later options', () => {
    const options = {
      valueOptions: new Set(['name']),
      aliases: { h: 'help' },
    };

    expect(hasBooleanFlag(['--help', '--name'], 'help', options)).toBe(true);
    expect(hasBooleanFlag(['--name', '--help'], 'help', options)).toBe(false);
  });

  it('does not let boolean flags consume the following positional argument', () => {
    expect(parseArgs(['--dry-run', 'archive.hmem'])).toEqual({
      flags: { 'dry-run': 'true' },
      positional: ['archive.hmem'],
    });
  });

  it('keeps the migrate-from-hmem source positional after bare --deduplicate', () => {
    expect(parseArgs(['--deduplicate', 'archive.hmem'], {
      valueOptions: valueOptionsFor('migrate-from-hmem'),
    })).toEqual({
      flags: { deduplicate: 'true' },
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

  it.each([
    ['resolve-project', undefined, 'walk-up'],
    ['new-project', undefined, 'no-git'],
    ['new-project', undefined, 'confirm'],
    ['setup-hermes-statusline', undefined, 'dry-run'],
    ['setup-hermes-statusline', undefined, 'skip-build'],
    ['import', undefined, 'dry-run'],
    ['import', undefined, 'deduplicate'],
    ['import', undefined, 'repair-flags'],
    ['import', undefined, 'no-snapshot-check'],
    ['migrate-from-hmem', undefined, 'deduplicate'],
    ['migrate-from-hmem', undefined, 'no-deduplicate'],
    ['migrate-from-hmem', undefined, 'dry-run'],
    ['migrate', 'tags-to-types', 'dry-run'],
    ['migrate', 'project-kind', 'dry-run'],
    ['snapshot', undefined, 'no-symlink'],
    ['snapshot', undefined, 'quiet'],
    ['restore', undefined, 'list'],
    ['restore', undefined, 'dry-run'],
    ['restore', undefined, 'force'],
    ['release-check', undefined, 'beta'],
    ['release-check', undefined, 'json'],
    ['setup-agent', undefined, 'dry-run'],
    ['sync', 'connect', 'register'],
  ])('does not classify documented boolean %s %s --%s as value-taking',
    (command, subcommand, flag) => {
      expect(valueOptionsFor(command!, subcommand).has(flag!)).toBe(false);
    });
});
