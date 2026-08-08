import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';

/**
 * Two live project roots sharing one label. `createProject` refuses to create
 * the second one, but P0062 carried two roots for two months (an hmem import
 * plus a later-created project), so the read side has to cope with a database
 * that already contains the duplicate.
 *
 * The failure this guards against is silent: every resolver used to `.get()` a
 * query matching both rows, so the answer depended on which row SQLite handed
 * back — and a repair call moved an entry across trees because two code paths
 * disagreed about which root "P0062" meant.
 */
async function twoRootsSharingLabel(store: TimStore): Promise<{ byId: string; other: string }> {
  // First root: created normally, so its id is the label itself — this is the
  // one `read('P0062')` finds through the id-direct path.
  const first = await store.createProject('P0062', { content: 'bbbee PM Workflow' });

  // Second root: written directly, the way the hmem import produced it.
  const second = await store.write('bbbee PM Workflow (imported)', {
    metadata: { kind: 'project', label: 'P0062', prefix: 'P', seq: 62 },
  });

  return { byId: first.id, other: second.id };
}

describe('duplicate project labels', () => {
  let store: TimStore;

  beforeEach(() => {
    store = new TimStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('resolveProjectLabel reports ambiguity instead of picking a root', async () => {
    // Neither root is named after the label here, so the lookup has to go
    // through the label query — the path where the two rows collide. (When one
    // root's id *is* the label, the id-direct lookup answers first and stays
    // deterministic; that is the case the section test below covers.)
    const first = await store.write('bbbee PM Workflow', {
      metadata: { kind: 'project', label: 'P0062', prefix: 'P', seq: 62 },
    });
    const second = await store.write('bbbee PM Workflow (imported)', {
      metadata: { kind: 'project', label: 'P0062', prefix: 'P', seq: 62 },
    });

    const ambiguous = await store.resolveProjectLabel('P0062');
    expect(ambiguous.status).toBe('ambiguous');
    if (ambiguous.status === 'ambiguous') {
      expect(ambiguous.labels).toHaveLength(2);
      expect(ambiguous.labels).toContain(first.id);
      expect(ambiguous.labels).toContain(second.id);
    }

    // Retiring one root makes the label name exactly one project again.
    await store.delete(second.id);
    const repaired = await store.resolveProjectLabel('P0062');
    expect(repaired.status).toBe('found');
    if (repaired.status === 'found') expect(repaired.label).toBe('P0062');
  });

  it('resolveSectionByTitle refuses rather than reaching into one of the two trees', async () => {
    const { byId, other } = await twoRootsSharingLabel(store);
    // A same-named section in each tree: the coin flip decided which one a
    // write landed in.
    await store.write('Tasks', { parentId: byId });
    await store.write('Tasks', { parentId: other });

    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('not_found');
    if (r.status === 'not_found') expect(r.candidates).toEqual([]);
  });

  it('resolves normally again once one of the two roots is retired', async () => {
    const { byId, other } = await twoRootsSharingLabel(store);
    const tasks = await store.write('Tasks', { parentId: byId });
    await store.write('Tasks', { parentId: other });

    // Soft-deleting the duplicate root is the repair that was available: the
    // label cannot be unset through the store's metadata merge.
    await store.delete(other);

    const r = await store.resolveSectionByTitle('P0062', 'Tasks');
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.id).toBe(tasks.id);
  });

  it('health() reports a duplicate label as a blocker, and only counts live roots', async () => {
    const { other } = await twoRootsSharingLabel(store);

    const report = await store.health();
    expect(report.status).toBe('BLOCKER');
    expect(report.blockers.some(b => b.includes('duplicate project label P0062'))).toBe(true);

    await store.delete(other);
    const afterRepair = await store.health();
    expect(afterRepair.blockers.some(b => b.includes('duplicate project label'))).toBe(false);
  });
});
