import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCallerProjectPath } from '../project-path.js';

describe('resolveCallerProjectPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-caller-path-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for HTTP transport', () => {
    expect(resolveCallerProjectPath(true, dir)).toBeUndefined();
  });

  it('returns cwd when no .tim-project marker exists', () => {
    expect(resolveCallerProjectPath(false, dir, { maxRoot: dir })).toBe(dir);
  });

  it('prefers the .tim-project directory over a nested cwd', () => {
    fs.writeFileSync(
      path.join(dir, '.tim-project'),
      JSON.stringify({
        version: 2,
        project: 'P9999',
        session: 'test',
        exchanges: 0,
        batch_size: 5,
        batches_summarized: 0,
      }),
      'utf8',
    );
    const nested = path.join(dir, 'packages', 'tim-mcp');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveCallerProjectPath(false, nested, { maxRoot: dir })).toBe(dir);
  });
});
