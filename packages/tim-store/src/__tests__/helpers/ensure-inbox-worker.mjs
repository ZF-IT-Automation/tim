import { TimStore, ensureInboxProject } from '../../../dist/index.js';

const store = new TimStore(process.env.TIM_DB_PATH);

process.send?.({ type: 'ready' });
process.on('message', async (message) => {
  if (message !== 'go') return;
  try {
    const entry = await ensureInboxProject(store);
    process.send?.({ type: 'result', id: entry.id });
  } catch (error) {
    process.send?.({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    store.close();
    process.disconnect?.();
  }
});
