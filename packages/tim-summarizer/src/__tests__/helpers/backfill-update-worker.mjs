import { TimStore } from '../../../../tim-store/dist/index.js';

const dbPath = process.env.TIM_DB_PATH;
const entryId = process.env.TIM_ENTRY_ID;
if (!dbPath || !entryId) {
  process.send?.({ type: 'error', error: 'missing TIM_DB_PATH or TIM_ENTRY_ID' });
  process.exit(1);
}

async function updateWithBusyRetry(store, id, patch) {
  const delays = [50, 150, 400];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      await store.update(id, patch);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
      const busy = code === 'SQLITE_BUSY' || /database is locked/i.test(msg);
      if (!busy || attempt === delays.length - 1) throw err;
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
}

process.send?.({ type: 'ready' });
process.on('message', async (message) => {
  if (message !== 'go') return;
  const store = new TimStore(dbPath);
  try {
    await updateWithBusyRetry(store, entryId, { metadata: { substance: 'real' } });
    process.send?.({ type: 'result' });
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
