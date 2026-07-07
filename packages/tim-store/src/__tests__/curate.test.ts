// TIM Store — Curation tool tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';

let store: TimStore;

beforeEach(() => {
  store = new TimStore(':memory:');
});

afterEach(() => {
  store.close();
});

describe('CurateManager', () => {
  describe('renameEntry', () => {
    it('should rename entry and update child parent_id references', async () => {
      await store.write('Parent', { id: 'OLD-ID' });
      const child = await store.write('Child', { parentId: 'OLD-ID' });
      await store.link('OLD-ID', child.id, 'relates');

      const renamed = store.curate().renameEntry('OLD-ID', 'NEW-ID');

      expect(renamed.id).toBe('NEW-ID');
      expect(await store.read('OLD-ID')).toBeNull();
      expect(await store.read('NEW-ID')).not.toBeNull();

      const readChild = await store.read(child.id);
      expect(readChild!.parentId).toBe('NEW-ID');

      const edges = await store.getEdges('NEW-ID', 'outgoing');
      expect(edges.some(e => e.targetId === child.id)).toBe(true);
    });

    it('should reject rename when newId already exists', async () => {
      await store.write('First', { id: 'EXISTING' });
      await store.write('Second', { id: 'TO-RENAME' });

      expect(() => store.curate().renameEntry('TO-RENAME', 'EXISTING'))
        .toThrow('Entry already exists: EXISTING');
    });

    it('should stage renamed entry for sync', async () => {
      await store.write('Staged', { id: 'STAGE-OLD' });
      store.curate().renameEntry('STAGE-OLD', 'STAGE-NEW');

      const staging = await store.getStaging();
      const keys = staging.map(s => s.key);
      expect(keys).toContain('STAGE-NEW');
    });
  });

  describe('moveEntry', () => {
    it('should move entry and cascade depth to descendants', async () => {
      const root = await store.write('Root');
      const branch = await store.write('Branch');
      const leaf = await store.write('Leaf', { parentId: branch.id });
      const grandchild = await store.write('Grand', { parentId: leaf.id });

      expect(branch.depth).toBe(1);
      expect(leaf.depth).toBe(2);
      expect(grandchild.depth).toBe(3);

      store.curate().moveEntry(branch.id, root.id);

      const moved = await store.read(branch.id);
      expect(moved!.parentId).toBe(root.id);
      expect(moved!.depth).toBe(2);

      const movedLeaf = await store.read(leaf.id);
      expect(movedLeaf!.depth).toBe(3);

      const movedGrand = await store.read(grandchild.id);
      expect(movedGrand!.depth).toBe(4);
    });

    it('materializes secret inside transaction when moved under secret parent', async () => {
      const deviceStore = new TimStore(':memory:', { deviceId: 'device-abc' });
      const secretParent = await deviceStore.write('Secret parent', {
        metadata: { secret: true },
      });
      const child = await deviceStore.write('Will inherit', { parentId: null });
      const grand = await deviceStore.write('Grandchild', { parentId: child.id });

      deviceStore.curate().moveEntry(child.id, secretParent.id);

      const db = deviceStore.getDb();
      for (const id of [child.id, grand.id]) {
        const row = db.prepare('SELECT metadata, lww_device FROM entries WHERE id = ?').get(id) as {
          metadata: string;
          lww_device: string;
        };
        expect(JSON.parse(row.metadata).secret).toBe(true);
        expect(row.lww_device).toBe('device-abc');
      }

      const staging = db.prepare('SELECT lww_device FROM staging WHERE key = ?').get(child.id) as {
        lww_device: string;
      };
      expect(staging.lww_device).toBe('device-abc');
      deviceStore.close();
    });
  });

  describe('updateMany', () => {
    it('should batch-update irrelevant and favorite flags', async () => {
      const a = await store.write('A');
      const b = await store.write('B');

      const updated = store.curate().updateMany([a.id, b.id], {
        irrelevant: true,
        favorite: true,
      });

      expect(updated).toHaveLength(2);
      expect(updated.every(e => e.irrelevant && e.favorite)).toBe(true);

      const readA = await store.read(a.id, { showIrrelevant: true });
      expect(readA!.favorite).toBe(true);
    });
  });

  describe('tagAdd', () => {
    it('should add tags without duplicates', async () => {
      const entry = await store.write('Tagged', { tags: ['#existing'] });
      const updated = store.curate().tagAdd(entry.id, ['#new', '#existing']);

      expect(updated.tags).toEqual(['#existing', '#new']);
    });
  });

  describe('tagRemove', () => {
    it('should remove specified tags', async () => {
      const entry = await store.write('Tagged', { tags: ['#keep', '#drop'] });
      const updated = store.curate().tagRemove(entry.id, ['#drop']);

      expect(updated.tags).toEqual(['#keep']);
    });
  });

  describe('tagRename', () => {
    it('should rename tag across all entries', async () => {
      await store.write('One', { tags: ['#old'] });
      await store.write('Two', { tags: ['#old', '#other'] });

      const count = store.curate().tagRename('#old', '#new');
      expect(count).toBe(2);

      const stats = await store.stats();
      const tagNames = stats.topTags.map(t => t.tag);
      expect(tagNames).toContain('#new');
      expect(tagNames).not.toContain('#old');
    });

    it('should not corrupt tags that merely contain the old tag as substring', async () => {
      const entry = await store.write('SQLite entry', { tags: ['#sqlite', '#sql'] });

      store.curate().tagRename('#sql', '#nosql');

      const read = await store.read(entry.id);
      expect(read!.tags).toContain('#sqlite');
      expect(read!.tags).toContain('#nosql');
      expect(read!.tags).not.toContain('#sql');
    });
  });
});
