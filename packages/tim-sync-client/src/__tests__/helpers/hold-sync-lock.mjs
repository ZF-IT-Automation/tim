import { tryAcquireSyncLock } from '../../../dist/lock.js';

const name = process.argv[2];
const lock = tryAcquireSyncLock(name);
if (!lock) process.exit(11);
process.stdout.write('held\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  lock.release();
  process.exit(0);
});
