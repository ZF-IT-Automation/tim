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
// A machine with TIM installed has this directory; code that opens
// ~/.tim/tim.db without creating it first would otherwise fail here for a
// reason no production run has.
fs.mkdirSync(path.join(home, '.tim'), { recursive: true });

process.on('exit', () => {
  fs.rmSync(home, { recursive: true, force: true });
});
