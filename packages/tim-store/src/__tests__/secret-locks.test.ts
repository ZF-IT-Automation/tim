import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TimStore } from '../store.js';

let store: TimStore;

beforeEach(() => { store = new TimStore(':memory:'); });
afterEach(() => { store.close(); });

function lock(id: string): void {
  store.getDb().prepare('UPDATE entries SET metadata = ? WHERE id = ?')
    .run(JSON.stringify({ secret: true, _enc: 'opaque' }), id);
}

describe('locked secret mutation boundary', () => {
  it('rejects caller lock fields on write and update, and reports marker removal', async () => {
    await expect(store.write('nope', { metadata: { _enc: 'x' } })).rejects.toThrow('reserved');
    const entry = await store.write('secret', { metadata: { secret: true } });
    await expect(store.update(entry.id, { metadata: { _enc_v: 2 } })).rejects.toThrow('reserved');
    await expect(store.update(entry.id, { metadata: { secret: null } })).rejects.toThrow('Cannot remove secret marker');
  });

  it('allows only ID-only hard deletion of locked rows', async () => {
    const one = await store.write('one');
    const two = await store.write('two');
    lock(one.id); lock(two.id);
    await expect(store.delete(one.id)).rejects.toThrow('locked secret');
    await expect(store.delete(one.id, true)).resolves.toBeUndefined();
    await expect(store.deleteBatch([two.id], false)).rejects.toThrow('locked secret');
    await expect(store.deleteBatch([two.id], true)).resolves.toBe(1);
  });

  it('guards verify, curation, supersedes, and sibling reorder before staging', async () => {
    const project = await store.write('project', { id: 'P9999', metadata: { kind: 'project', label: 'P9999' } });
    const root = await store.write('root', { parentId: project.id });
    const locked = await store.write('locked', { parentId: root.id, tags: ['#old'] });
    const sibling = await store.write('sibling', { parentId: root.id });
    const target = await store.write('target', { parentId: project.id });
    lock(locked.id);
    await expect(store.touchVerified([locked.id])).rejects.toThrow('locked secret');
    expect(() => store.curate().renameEntry(locked.id, 'RENAMED')).toThrow('locked secret');
    expect(() => store.curate().moveEntry(locked.id, null)).toThrow('locked secret');
    expect(() => store.curate().updateMany([locked.id], { favorite: true })).toThrow('locked secret');
    expect(() => store.curate().tagRemove(locked.id, ['#old'])).toThrow('locked secret');
    expect(() => store.curate().tagRename('#old', '#new')).toThrow('locked secret');
    await expect(store.link(locked.id, target.id, 'supersedes', 1, { effectiveAt: '2026-01-01T00:00:00Z' }))
      .rejects.toThrow('locked secret');
    expect(() => store.curate().moveEntry(sibling.id, root.id, 0)).toThrow('locked secret');
  });
});
