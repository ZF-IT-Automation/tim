import type Database from 'better-sqlite3';
import type { TimStore } from './store.js';

function rowHasSecret(metadataJson: string): boolean {
  try {
    return (
      (JSON.parse(metadataJson) as { secret?: boolean }).secret === true ||
      Number(
        (JSON.parse(metadataJson) as Record<string, unknown>).secret,
      ) === 1
    );
  } catch {
    return false;
  }
}

/** Walk parent chain; true if any ancestor has metadata.secret=true. */
export function parentIsSecret(db: Database.Database, parentId: string | null): boolean {
  if (!parentId) return false;
  const visited = new Set<string>();
  let current: string | null = parentId;

  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);

    const row = db
      .prepare('SELECT parent_id, metadata FROM entries WHERE id = ?')
      .get(current) as { parent_id: string | null; metadata: string } | undefined;
    if (!row) return false;
    if (rowHasSecret(row.metadata)) return true;
    current = row.parent_id;
  }

  return false;
}

/** Own secret flag OR inherited via parent chain. */
export function isSecret(db: Database.Database, id: string): boolean {
  const row = db
    .prepare('SELECT metadata, parent_id FROM entries WHERE id = ?')
    .get(id) as { metadata: string; parent_id: string | null } | undefined;
  if (!row) return false;
  if (rowHasSecret(row.metadata)) return true;
  return parentIsSecret(db, row.parent_id);
}

/** First ancestor (including self) with secret=true, or null. */
export function findSecretSource(db: Database.Database, id: string): string | null {
  const visited = new Set<string>();
  let current: string | null = id;

  while (current) {
    if (visited.has(current)) return null;
    visited.add(current);

    const row = db
      .prepare('SELECT parent_id, metadata FROM entries WHERE id = ?')
      .get(current) as { parent_id: string | null; metadata: string } | undefined;
    if (!row) return null;
    if (rowHasSecret(row.metadata)) return current;
    current = row.parent_id;
  }

  return null;
}

function collectSubtreeIds(db: Database.Database, rootId: string): string[] {
  const ids: string[] = [];
  const queue = [rootId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    ids.push(nodeId);

    const children = db
      .prepare('SELECT id FROM entries WHERE parent_id = ? AND tombstoned_at IS NULL')
      .all(nodeId) as { id: string }[];
    for (const child of children) queue.push(child.id);
  }

  return ids;
}

/** Synchronous materialization for moveEntry transaction path. */
export function materializeSecretSubtreeSync(
  db: Database.Database,
  rootId: string,
  deviceId = 'local',
): number {
  let count = 0;
  const now = new Date().toISOString();
  const ts = Date.now();

  for (const nodeId of collectSubtreeIds(db, rootId)) {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(nodeId) as
      | Record<string, unknown>
      | undefined;
    if (!row) continue;

    const meta = JSON.parse(String(row.metadata)) as Record<string, unknown>;
    if (meta.secret === true) continue;

    meta.secret = true;
    const metadata = JSON.stringify(meta);
    db.prepare('UPDATE entries SET metadata = ?, updated_at = ?, lww_device = ? WHERE id = ?').run(
      metadata,
      now,
      deviceId,
      nodeId,
    );

    const staged = { ...row, metadata, updated_at: now, lww_device: deviceId };
    db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
      nodeId,
      JSON.stringify(staged),
      ts,
      deviceId,
      Number(row.confidence ?? 1),
    );
    count++;
  }

  return count;
}

/** BFS subtree; materialize secret via store.update() for sync staging. */
export async function setSecretSubtree(store: TimStore, id: string): Promise<number> {
  const db = store.getDb();
  let count = 0;

  for (const nodeId of collectSubtreeIds(db, id)) {
    const row = db
      .prepare('SELECT metadata FROM entries WHERE id = ?')
      .get(nodeId) as { metadata: string } | undefined;
    if (!row || rowHasSecret(row.metadata)) continue;
    await store.update(nodeId, { metadata: { secret: true } });
    count++;
  }

  return count;
}

/** After reparent: materialize secret on moved subtree when new parent is secret. */
export async function ensureSecretInheritance(
  store: TimStore,
  id: string,
  newParentId: string | null,
): Promise<void> {
  if (parentIsSecret(store.getDb(), newParentId)) {
    await setSecretSubtree(store, id);
  }
}
