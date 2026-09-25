// Short-lived child for the embedding timer. The ONNX runtime keeps its memory
// arena until the process exits — 2.4 GB measured in the MCP singleton after the
// first backfill — so the model is loaded here, not in the long-lived server.
import { embedUnembeddedEntries } from 'tim-hooks';
import { TimStore } from 'tim-store';

/** Embed batch after batch until nothing is left. */
export async function drainEmbeddings(store: TimStore): Promise<number> {
  let total = 0;
  for (let n = await embedUnembeddedEntries(store); n > 0; n = await embedUnembeddedEntries(store)) total += n;
  return total;
}

if (require.main === module) {
  const store = new TimStore(process.argv[2]!);
  drainEmbeddings(store)
    .catch(() => 0)
    .finally(() => {
      store.close();
      process.exit(0);
    });
}
