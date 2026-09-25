// Point HOME at an empty directory for the duration of the test run.
//
// TimStore and the hooks read ~/.tim/config.json for their defaults, so without
// this the suite inherits whatever the developer has configured on the machine
// it happens to run on. That is not hypothetical: switching `sync.staging` off
// locally made 30 tests across 9 files fail, because they assert that a write
// stages an outbox record and the ambient config had just turned staging off.
//
// This replaces the `env HOME=$(mktemp -d)` prefix the test command carried by
// hand — the isolation now belongs to the suite rather than to whoever
// remembers to type it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
// Workers run with TEAMUP_WORKER=1; session hooks must not inherit that in tests.
delete process.env.TEAMUP_WORKER;
delete process.env.TEAMUP_RUN_ID;
// Running the suite inside Claude Code: its session id would resolve as the harness session.
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.TIM_SESSION_ID;
// A developer's TIM_DB_PATH would point tests that forget their own at the live DB.
delete process.env.TIM_DB_PATH;
delete process.env.TIM_EMBEDDING_DISABLED;
delete process.env.TIM_EMBEDDING_MODEL;
delete process.env.TIM_EMBEDDING_REAL_MODEL;
// Jev is a network call; the suite mocks fetch and must never bill the real key.
delete process.env.JEV_API_KEY;
// A machine with TIM installed has this directory; code that opens
// ~/.tim/tim.db without creating it first would otherwise fail here for a
// reason no production run has.
fs.mkdirSync(path.join(home, '.tim'), { recursive: true });

process.on('exit', () => {
  fs.rmSync(home, { recursive: true, force: true });
});
