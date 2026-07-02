// Export tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { TimStore } from 'tim-store';
import { tim_export, exportToMarkdown } from '../export.js';
import { tim_import } from '../import.js';
import { detectHmemFormat } from '../hmem-format.js';

let store: TimStore;
let tmpDir: string;

beforeEach(() => {
  store = new TimStore(':memory:');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-export-test-'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tim_export', () => {
  it('exports hierarchical markdown with headings, tags, and related links', async () => {
    const root = await store.write('Project Alpha', {
      tags: ['#project'],
      metadata: { label: 'P0001', prefix: 'P', seq: 1 },
    });
    await store.write('Overview detail', { parentId: root.id });
    const other = await store.write('Related entry', {
      metadata: { label: 'L0002', prefix: 'L', seq: 2 },
    });
    await store.link(root.id, other.id, 'relates');

    const md = exportToMarkdown(store);

    expect(md).toContain('# Project Alpha #project');
    expect(md).toContain('## Overview detail');
    expect(md).toContain('Related: [L0002]');
    expect(md).toContain('Entries: 3');
  });

  it('exports to hmem v2 sqlite with entries, nodes, and links', async () => {
    const root = await store.write('Root content', {
      metadata: { label: 'P0001', prefix: 'P', seq: 1 },
    });
    const child = await store.write('Child content', { parentId: root.id });
    const target = await store.write('Target', {
      metadata: { label: 'L0001', prefix: 'L', seq: 1 },
    });
    await store.link(root.id, target.id, 'relates');

    const outPath = path.join(tmpDir, 'export.hmem');
    const result = tim_export(store, outPath, { format: 'hmem' });

    expect(result).toMatchObject({
      targetPath: outPath,
      entriesExported: 2,
      nodesExported: 1,
      linksExported: 1,
    });

    const db = new Database(outPath, { readonly: true });
    expect(detectHmemFormat(db)).toBe('v2');

    const entry = db.prepare('SELECT * FROM entries WHERE uid = ?').get(root.id) as {
      label: string;
      level_1: string;
    };
    expect(entry.label).toBe('P0001');
    expect(entry.level_1).toBe('Root content');

    const node = db.prepare('SELECT * FROM nodes WHERE uid = ?').get(child.id) as {
      root_uid: string;
      content: string;
    };
    expect(node.root_uid).toBe(root.id);
    expect(node.content).toBe('Child content');

    const link = db.prepare('SELECT * FROM links WHERE src_uid = ?').get(root.id) as {
      dst_uid: string;
      kind: string;
    };
    expect(link.dst_uid).toBe(target.id);
    expect(link.kind).toBe('relates');
    db.close();
  });

  it('roundtrips export → import into fresh DB with identical structure', async () => {
    const root = await store.write('Roundtrip root', {
      metadata: { label: 'P0099', prefix: 'P', seq: 99 },
      tags: ['#test'],
    });
    const child = await store.write('Roundtrip child', {
      parentId: root.id,
      tags: ['#child'],
    });
    const other = await store.write('Other root', {
      metadata: { label: 'L0001', prefix: 'L', seq: 1 },
    });
    await store.link(root.id, other.id, 'implements');

    const outPath = path.join(tmpDir, 'roundtrip.hmem');
    tim_export(store, outPath, { format: 'hmem' });

    const freshPath = path.join(tmpDir, 'fresh.db');
    const fresh = new TimStore(freshPath);
    try {
      const report = tim_import(fresh, outPath);
      expect(report.entriesImported).toBe(2);
      expect(report.nodesImported).toBe(1);
      expect(report.edgesImported).toBe(1);

      const importedRoot = await fresh.read(root.id);
      expect(importedRoot).not.toBeNull();
      expect(importedRoot!.title).toBe('Roundtrip root');
      expect(importedRoot!.metadata.label).toBe('P0099');
      expect(importedRoot!.tags).toEqual(['#test']);

      const children = await fresh.getChildren(root.id);
      expect(children).toHaveLength(1);
      expect(children[0].title).toBe('Roundtrip child');
      expect(children[0].tags).toEqual(['#child']);

      const edges = await fresh.getEdges(root.id, 'outgoing');
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe('implements');
      expect(edges[0].targetId).toBe(other.id);
    } finally {
      fresh.close();
    }
  });

  it('respects entryFilter and includes ancestors', async () => {
    const root = await store.write('Keep root', {
      metadata: { label: 'P0001', prefix: 'P', seq: 1 },
    });
    await store.write('Keep child', { parentId: root.id });
    await store.write('Skip root', {
      metadata: { label: 'P0002', prefix: 'P', seq: 2 },
    });

    const outPath = path.join(tmpDir, 'filtered.hmem');
    const result = tim_export(store, outPath, {
      format: 'hmem',
      entryFilter: e => (e.metadata.label as string) === 'P0001' ||
        e.parentId !== null && e.title === 'Keep child',
    });

    expect(result).toMatchObject({ entriesExported: 1, nodesExported: 1 });

    const db = new Database(outPath, { readonly: true });
    const count = (db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }).c;
    expect(count).toBe(1);
    db.close();
  });
});
