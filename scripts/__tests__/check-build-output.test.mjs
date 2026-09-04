import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  distCounterpart,
  findMissingBuildOutputs,
  isCompiledSource,
  missingBuildOutputs,
} from '../check-build-output.mjs';

describe('isCompiledSource', () => {
  it('accepts a plain source module', () => {
    expect(isCompiledSource('src/maintenance-lock.ts')).toBe(true);
  });

  it('rejects tests, declarations and non-TS files', () => {
    expect(isCompiledSource('src/__tests__/maintenance-lock.test.ts')).toBe(false);
    expect(isCompiledSource('src/__tests__/helpers.ts')).toBe(false);
    expect(isCompiledSource('src/args.spec.ts')).toBe(false);
    expect(isCompiledSource('src/types.d.ts')).toBe(false);
    expect(isCompiledSource('src/schema.json')).toBe(false);
  });
});

describe('distCounterpart', () => {
  it('maps src to dist and ts to js', () => {
    expect(distCounterpart('src/index.ts')).toBe('dist/index.js');
    expect(distCounterpart('src/nested/deep.ts')).toBe('dist/nested/deep.js');
  });
});

describe('missingBuildOutputs', () => {
  it('reports a source module that has no compiled counterpart', () => {
    // The 2026-09-03 outage: dist/index.js requires maintenance-lock.js,
    // which the build never produced.
    const missing = missingBuildOutputs(
      ['src/index.ts', 'src/maintenance-lock.ts'],
      ['dist/index.js'],
    );
    expect(missing).toEqual(['dist/maintenance-lock.js']);
  });

  it('is silent on a complete build', () => {
    expect(missingBuildOutputs(['src/index.ts'], ['dist/index.js', 'dist/index.d.ts'])).toEqual([]);
  });

  it('does not demand output for tests or declarations', () => {
    expect(
      missingBuildOutputs(['src/__tests__/a.test.ts', 'src/types.d.ts'], []),
    ).toEqual([]);
  });

  it('reports every missing module, not only the first', () => {
    expect(missingBuildOutputs(['src/a.ts', 'src/b.ts', 'src/c.ts'], ['dist/b.js'])).toEqual([
      'dist/a.js',
      'dist/c.js',
    ]);
  });
});

describe('findMissingBuildOutputs', () => {
  // `pretest` builds before vitest runs; a bare `npx vitest run` may not have.
  it.skipIf(!existsSync('packages/tim-core/dist'))(
    'finds nothing missing in this repository once it is built',
    async () => {
      const { missing, checked } = await findMissingBuildOutputs();
      expect(missing).toEqual([]);
      expect(checked).toBeGreaterThan(50);
    },
  );
});
