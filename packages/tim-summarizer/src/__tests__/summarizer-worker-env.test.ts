import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryCli } from '../generate-summary.js';

// The summarizer's own LLM calls must run as team-up workers, or each CLI's TIM
// hooks log the call as a new project session (97 junk sessions in one backfill).
describe('summarizer CLI spawn', () => {
  it('marks the spawned CLI as a worker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-worker-env-'));
    const fake = path.join(dir, 'codex');
    fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "- worker flag: [$TEAMUP_WORKER]"\n', { mode: 0o755 });
    const oldPath = process.env.PATH;
    const oldFlag = process.env.TEAMUP_WORKER;
    process.env.PATH = `${dir}:${oldPath}`;
    delete process.env.TEAMUP_WORKER;
    try {
      const out = await tryCli('codex', 'any-model', undefined, 'prompt', 10);
      expect(out).toContain('worker flag: [1]');
    } finally {
      process.env.PATH = oldPath;
      if (oldFlag === undefined) delete process.env.TEAMUP_WORKER;
      else process.env.TEAMUP_WORKER = oldFlag;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
