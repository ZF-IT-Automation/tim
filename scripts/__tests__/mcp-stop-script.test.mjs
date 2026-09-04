import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const stopScript = join(scriptsDir, 'tim-mcp-stop.sh');

describe('tim-mcp-stop.sh', () => {
  it('is syntactically valid bash', () => {
    expect(() => execFileSync('bash', ['-n', stopScript])).not.toThrow();
  });

  // `if ! pids=$(pgrep ...); then local rc=$?; ...` captures the negation's
  // status (0), not pgrep's (1). The script then took its "pgrep error" branch
  // and exited 1 every time there was simply nothing to stop, which aborted
  // `tim restore` and the nightly compaction job.
  it('does not read $? from inside a negated assignment', () => {
    // Comments are stripped: the fix documents the broken form in prose.
    const code = readFileSync(stopScript, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/if\s+!\s+\w+=\$\(/);
  });

  it('captures pgrep status through || so exit 1 stays distinguishable', () => {
    const source = readFileSync(stopScript, 'utf8');
    expect(source).toMatch(/pids=\$\(pgrep[^)]*\)\s*\|\|\s*rc=\$\?/);
  });

  // The behaviour the bug broke: a no-match pgrep must mean "nothing to stop",
  // not "pgrep failed". Reproduced against the same idiom the script now uses,
  // with a pattern that cannot match the test process's own command line.
  it('treats a no-match pgrep as success, not as an error', () => {
    const probe = `
      set -euo pipefail
      pat="nomatch-$$-$(date +%s%N)"
      rc=0
      pids=$(pgrep -f "$pat") || rc=$?
      echo "rc=$rc"
    `;
    const out = execFileSync('bash', ['-c', probe], { encoding: 'utf8' });
    expect(out.trim()).toBe('rc=1');
  });
});
