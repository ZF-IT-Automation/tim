import { TimStore, setSecretSubtree, isSecret, findSecretSource, parentIsSecret } from 'tim-store';
import { loadConfig, type TimConfigFile } from 'tim-core';
import * as path from 'path';
import * as os from 'os';

function getDbPath(config: TimConfigFile): string {
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

export async function cmdSecret(args: string[]): Promise<void> {
  const sub = args[0];
  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
  const db = store.getDb();

  try {
    switch (sub) {
      case 'set': {
        const id = args[1];
        if (!id) {
          console.error('Usage: tim secret set <id>');
          process.exit(1);
        }
        const count = await setSecretSubtree(store, id);
        const total = count > 0 ? count : 1;
        console.log(`✓ Secret set on ${id} (+${total - 1} descendants)`);
        break;
      }
      case 'status': {
        const id = args[1];
        if (!id) {
          console.error('Usage: tim secret status <id>');
          process.exit(1);
        }
        const row = db.prepare('SELECT parent_id FROM entries WHERE id = ?').get(id) as
          | { parent_id: string | null }
          | undefined;
        if (!row) {
          console.error(`Entry not found: ${id}`);
          process.exit(1);
        }
        if (!isSecret(db, id)) {
          console.log('secret: false');
          break;
        }
        if (row.parent_id && parentIsSecret(db, row.parent_id)) {
          const source = findSecretSource(db, row.parent_id);
          console.log(`secret: true (inherited from ${source})`);
        } else {
          console.log('secret: true (own)');
        }
        break;
      }
      case 'list': {
        const rows = db.prepare(`
          SELECT id, title, metadata, parent_id FROM entries
          WHERE json_extract(metadata, '$.secret') = 1
            AND tombstoned_at IS NULL
          ORDER BY id
        `).all() as { id: string; title: string; metadata: string; parent_id: string | null }[];

        if (rows.length === 0) {
          console.log('No secret entries.');
          break;
        }

        console.log('ID\tTitle\tInherited');
        for (const row of rows) {
          const title = row.title.length > 40 ? `${row.title.slice(0, 37)}...` : row.title;
          const inherited =
            row.parent_id && parentIsSecret(db, row.parent_id) ? 'yes' : 'no';
          console.log(`${row.id}\t${title}\t${inherited}`);
        }
        break;
      }
      default:
        console.error('Usage: tim secret <set|status|list> ...');
        process.exit(1);
    }
  } finally {
    store.close();
  }
}
