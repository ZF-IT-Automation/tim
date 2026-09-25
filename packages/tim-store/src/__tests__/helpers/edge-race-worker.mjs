import { TimStore } from '../../../dist/index.js';

const dbPath = process.env.TIM_DB_PATH;
if (!dbPath) {
  process.send?.({ type: 'error', error: 'TIM_DB_PATH is required' });
  process.exit(1);
}

const store = new TimStore(dbPath, { deviceId: 'stale' });
process.send?.({ type: 'ready' });

process.on('message', (message) => {
  if (!message || typeof message !== 'object' || !('cmd' in message)) return;
  process.send?.({ type: 'calling' }, () => {
    const run = message.cmd === 'unlink'
      ? store.unlink(message.edgeId)
      : store.link('source', 'target', 'relates', 1, { from: 'stale' });
    Promise.resolve(run).then(
      () => process.send?.({ type: 'done' }),
      (error) => process.send?.({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }),
    ).finally(() => {
      store.close();
      process.disconnect?.();
    });
  });
});
