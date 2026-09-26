import { TimStore, setSecretSubtree, isSecret, findSecretSource, parentIsSecret } from 'tim-store';
import { loadConfig, type TimConfigFile } from 'tim-core';
import { decrypt, deriveKey, resolveSecretPassphrase, unlockPersistedSecretEntries } from 'tim-sync-client';
import { parseArgs, valueOptionsFor } from './args.js';
import * as path from 'path';
import * as os from 'os';

function getDbPath(config: TimConfigFile): string {
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

export async function cmdSecret(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args, { valueOptions: valueOptionsFor('secret', args[0]) });
  const sub = positional[0];
  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
  const db = store.getDb();

  try {
    switch (sub) {
      case 'set': {
        const id = positional[1];
        if (!id) {
          console.error('Usage: tim secret set <id>');
          process.exit(1);
        }
        const exists = db.prepare('SELECT id FROM entries WHERE id = ?').get(id);
        if (!exists) {
          console.error(`Entry not found: ${id}`);
          process.exit(1);
        }
        const count = await setSecretSubtree(store, id);
        console.log(`✓ Secret set on ${id} (+${count - 1} descendants)`);
        break;
      }
      case 'status': {
        const id = positional[1];
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
      case 'unlock': {
        const secretPassphrase = resolveSecretPassphrase(flags);
        const salt = flags.salt ?? process.env.TIM_SECRET_SALT;
        if (!secretPassphrase || !salt) {
          console.error('Usage: tim secret unlock --secret-passphrase <text> --salt <sync-salt>');
          console.error('Set TIM_SECRET_PASSPHRASE and TIM_SECRET_SALT instead to avoid command-line secrets.');
          process.exit(1);
        }
        const key = deriveKey(secretPassphrase, salt);
        const result = unlockPersistedSecretEntries(store, (ciphertext) => decrypt(ciphertext, key));
        console.log(`Unlocked ${result.unlocked} secret ${result.unlocked === 1 ? 'entry' : 'entries'}${result.skipped ? `; skipped ${result.skipped} undecryptable` : ''}`);
        break;
      }
      default:
        console.error('Usage: tim secret <set|status|list|unlock> ...');
        console.error('Note: secret is one-directional — there is no unset command.');
        process.exit(1);
    }
  } finally {
    store.close();
  }
}
