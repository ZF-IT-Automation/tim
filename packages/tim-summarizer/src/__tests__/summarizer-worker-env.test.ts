import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { perCliTimeoutSec, tryCli } from '../generate-summary.js';

// The summarizer's own LLM calls must run as team-up workers, or each CLI's TIM
// hooks log the call as a new project session (97 junk sessions in one backfill).
describe('summarizer CLI spawn', () => {
  it('marks the spawned CLI as a worker', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-worker-env-'));
    const fake = path.join(dir, 'codex');
    fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho "- worker flag: [$TEAMUP_WORKER] summarizer flag: [$TIM_SUMMARIZER]"\n', { mode: 0o755 });
    const oldPath = process.env.PATH;
    const oldFlag = process.env.TEAMUP_WORKER;
    process.env.PATH = `${dir}:${oldPath}`;
    delete process.env.TEAMUP_WORKER;
    try {
      const out = await tryCli('codex', 'any-model', undefined, 'prompt', 10);
      expect(out).toContain('worker flag: [1]');
      expect(out).toContain('summarizer flag: [1]');
    } finally {
      process.env.PATH = oldPath;
      if (oldFlag === undefined) delete process.env.TEAMUP_WORKER;
      else process.env.TEAMUP_WORKER = oldFlag;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns after its timeout even when a grandchild holds stdout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-hang-'));
    const fake = path.join(dir, 'codex');
    // Ignores SIGTERM and leaves a grandchild holding stdout: 'close' alone would wait 60 s.
    fs.writeFileSync(fake, '#!/bin/sh\ntrap "" TERM\nsleep 60 &\nwhile :; do sleep 1; done\n', { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    const started = Date.now();
    try {
      const out = await tryCli('codex', 'any-model', undefined, 'prompt', 1);
      expect(out).toBeNull();
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('splits the supervisor budget so the last chain slot still runs', () => {
    const old = process.env.TIM_SUMMARIZER_BUDGET_SEC;
    try {
      delete process.env.TIM_SUMMARIZER_BUDGET_SEC;
      expect(perCliTimeoutSec(600, 2)).toBe(600);
      process.env.TIM_SUMMARIZER_BUDGET_SEC = '600';
      const perCli = perCliTimeoutSec(600, 2);
      expect(2 * (perCli + 5)).toBeLessThan(600);
      expect(perCliTimeoutSec(60, 2)).toBe(60);
    } finally {
      if (old === undefined) delete process.env.TIM_SUMMARIZER_BUDGET_SEC;
      else process.env.TIM_SUMMARIZER_BUDGET_SEC = old;
    }
  });
});
