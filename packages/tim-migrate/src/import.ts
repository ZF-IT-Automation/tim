// TIM Import — .hmem SQLite → TIM store

import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { TimStore } from 'tim-store';
import { detectHmemFormat, inspectHmemFile, parseLabel } from './hmem-format.js';

export interface ImportOptions {
  dryRun?: boolean;
  deduplicate?: boolean;
}

export interface ImportConflict {
  label: string;
  action: 'merged' | 'remapped' | 'skipped';
  detail?: string;
}

export interface ImportReport {
  sourcePath: string;
  format: 'v2' | 'old' | 'unknown';
  dryRun: boolean;
  entriesImported: number;
  nodesImported: number;
  edgesImported: number;
  skipped: number;
  remapped: number;
  conflicts: ImportConflict[];
  newCount: number;
  changedCount: number;
  warnings: string[];
}

interface V2Entry {
  uid: string;
  label: string;
  prefix: string;
  seq: number;
  level_1: string;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string | null;
  obsolete: number;
  favorite: number;
  irrelevant: number;
  pinned: number;
  tags: string | null;
  deleted_at: string | null;
}

interface V2Node {
  uid: string;
  root_uid: string;
  parent_uid: string | null;
  depth: number;
  seq: number;
  content: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
  irrelevant: number;
  deleted_at: string | null;
}

interface V2Link {
  src_uid: string;
  dst_uid: string;
  kind: string | null;
}

interface OldHmemEntry {
  id: string;
  prefix: string;
  seq: number;
  created_at: string;
  level_1: string;
  level_2: string | null;
  level_3: string | null;
  level_4: string | null;
  level_5: string | null;
  last_accessed: string | null;
  links: string | null;
  obsolete: number;
  favorite: number;
  irrelevant: number;
  title: string | null;
  pinned: number;
  updated_at: string | null;
}

function findByLabel(store: TimStore, label: string): string | null {
  const row = store.getDb().prepare(
    "SELECT id FROM entries WHERE json_extract(metadata, '$.label') = ? AND tombstoned_at IS NULL",
  ).get(label) as { id: string } | undefined;
  return row?.id ?? null;
}

function entryExists(store: TimStore, id: string): boolean {
  const row = store.getDb().prepare(
    'SELECT id FROM entries WHERE id = ? AND tombstoned_at IS NULL',
  ).get(id) as { id: string } | undefined;
  return !!row;
}

function contentChanged(store: TimStore, id: string, content: string): boolean {
  const row = store.getDb().prepare(
    'SELECT content FROM entries WHERE id = ?',
  ).get(id) as { content: string } | undefined;
  return !!row && row.content !== content;
}

function insertEntryDirect(
  db: Database.Database,
  params: {
    id: string;
    parentId: string | null;
    content: string;
    depth: number;
    confidence: number;
    createdAt: string;
    accessedAt: string;
    tags: string[];
    irrelevant: boolean;
    favorite: boolean;
    metadata: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO entries (
      id, parent_id, content, content_type, depth, confidence, created_at, accessed_at,
      decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata
    ) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, 0.0, 1, ?, ?, ?, NULL, ?)
  `).run(
    params.id,
    params.parentId,
    params.content,
    params.depth,
    params.confidence,
    params.createdAt,
    params.accessedAt,
    JSON.stringify(params.tags),
    params.irrelevant ? 1 : 0,
    params.favorite ? 1 : 0,
    JSON.stringify(params.metadata),
  );
}

function insertEdgeDirect(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  type: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, metadata)
    VALUES (?, ?, ?, ?, 1.0, '{}')
  `).run(ulid(), sourceId, targetId, type);
}

function importV2(
  source: Database.Database,
  store: TimStore,
  options: ImportOptions,
): Omit<ImportReport, 'sourcePath' | 'format' | 'dryRun'> {
  const warnings: string[] = [];
  const conflicts: ImportConflict[] = [];
  let entriesImported = 0;
  let nodesImported = 0;
  let edgesImported = 0;
  let skipped = 0;
  let remapped = 0;
  let newCount = 0;
  let changedCount = 0;

  const hmemEntries = source.prepare(`
    SELECT uid, label, prefix, seq, level_1, created_at, updated_at,
           access_count, last_accessed, obsolete, favorite, irrelevant, pinned, tags, deleted_at
    FROM entries
    WHERE deleted_at IS NULL
    ORDER BY seq ASC
  `).all() as V2Entry[];

  const hmemNodes = source.prepare(`
    SELECT uid, root_uid, parent_uid, depth, seq, content, tags,
           created_at, updated_at, irrelevant, deleted_at
    FROM nodes
    WHERE deleted_at IS NULL
    ORDER BY depth ASC, seq ASC
  `).all() as V2Node[];

  const hmemLinks = source.prepare(`
    SELECT src_uid, dst_uid, kind FROM links
  `).all() as V2Link[];

  const idMap = new Map<string, string>();
  const mergedRoots = new Set<string>();

  const planRoots = () => {
    for (const e of hmemEntries) {
      const existingLabel = findByLabel(store, e.label);
      const tags = e.tags ? JSON.parse(e.tags) as string[] : [];

      if (existingLabel && options.deduplicate) {
        idMap.set(e.uid, existingLabel);
        mergedRoots.add(e.uid);
        if (contentChanged(store, existingLabel, e.level_1)) {
          changedCount++;
        } else {
          skipped++;
        }
        conflicts.push({ label: e.label, action: 'merged', detail: existingLabel });
        continue;
      }

      let timId = e.uid;
      if (entryExists(store, e.uid) || (existingLabel && !options.deduplicate)) {
        timId = ulid();
        remapped++;
        conflicts.push({
          label: e.label,
          action: 'remapped',
          detail: `${e.uid} → ${timId}`,
        });
      } else {
        newCount++;
      }

      idMap.set(e.uid, timId);

      if (options.dryRun) continue;

      insertEntryDirect(store.getDb(), {
        id: timId,
        parentId: null,
        content: e.level_1,
        depth: 1,
        confidence: e.obsolete ? 0.3 : 0.9,
        createdAt: e.created_at,
        accessedAt: e.updated_at,
        tags,
        irrelevant: e.irrelevant === 1,
        favorite: e.favorite === 1,
        metadata: {
          label: e.label,
          prefix: e.prefix,
          seq: e.seq,
          hmemUid: e.uid,
          pinned: e.pinned === 1,
          importedAt: new Date().toISOString(),
        },
      });
      entriesImported++;
    }
  };

  const planNodes = () => {
    for (const n of hmemNodes) {
      const rootTimId = idMap.get(n.root_uid);
      if (!rootTimId) {
        warnings.push(`Skipped node ${n.uid}: root ${n.root_uid} not mapped`);
        continue;
      }

      const parentTimId = n.parent_uid ? idMap.get(n.parent_uid) : rootTimId;
      if (!parentTimId) {
        warnings.push(`Skipped node ${n.uid}: parent ${n.parent_uid} not mapped`);
        continue;
      }

      let timId = n.uid;
      if (entryExists(store, n.uid)) {
        timId = ulid();
        remapped++;
        conflicts.push({
          label: n.uid,
          action: 'remapped',
          detail: `${n.uid} → ${timId}`,
        });
      } else {
        newCount++;
      }

      idMap.set(n.uid, timId);
      const tags = n.tags ? JSON.parse(n.tags) as string[] : [];

      if (options.dryRun) continue;

      insertEntryDirect(store.getDb(), {
        id: timId,
        parentId: parentTimId,
        content: n.content,
        depth: Math.min(Math.max(n.depth, 2), 5),
        confidence: 0.9,
        createdAt: n.created_at,
        accessedAt: n.updated_at,
        tags,
        irrelevant: n.irrelevant === 1,
        favorite: false,
        metadata: {
          hmemUid: n.uid,
          importedAt: new Date().toISOString(),
        },
      });
      nodesImported++;
    }
  };

  const planLinks = () => {
    for (const link of hmemLinks) {
      const src = idMap.get(link.src_uid);
      const dst = idMap.get(link.dst_uid);
      if (!src || !dst) {
        warnings.push(`Skipped link ${link.src_uid} → ${link.dst_uid}: endpoint not mapped`);
        continue;
      }
      if (options.dryRun) continue;
      insertEdgeDirect(store.getDb(), src, dst, link.kind ?? 'relates');
      edgesImported++;
    }
  };

  const run = () => {
    planRoots();
    planNodes();
    planLinks();
  };

  if (options.dryRun) {
    run();
  } else {
    const tx = store.getDb().transaction(run);
    tx();
  }

  return {
    entriesImported,
    nodesImported,
    edgesImported,
    skipped,
    remapped,
    conflicts,
    newCount,
    changedCount,
    warnings,
  };
}

function importOld(
  source: Database.Database,
  store: TimStore,
  options: ImportOptions,
): Omit<ImportReport, 'sourcePath' | 'format' | 'dryRun'> {
  const warnings: string[] = [];
  const conflicts: ImportConflict[] = [];
  let entriesImported = 0;
  let nodesImported = 0;
  let edgesImported = 0;
  let skipped = 0;
  let remapped = 0;
  let newCount = 0;
  let changedCount = 0;

  const cols = (source.prepare('PRAGMA table_info(memories)').all() as { name: string }[])
    .map(c => c.name);
  const hasTitle = cols.includes('title');
  const hasUpdatedAt = cols.includes('updated_at');

  const selectSql = `
    SELECT id, prefix, seq, created_at, level_1, level_2, level_3, level_4, level_5,
           last_accessed, links, obsolete, favorite, irrelevant,
           ${hasTitle ? 'title' : 'NULL as title'},
           ${cols.includes('pinned') ? 'pinned' : '0 as pinned'},
           ${hasUpdatedAt ? 'updated_at' : 'NULL as updated_at'}
    FROM memories
    ORDER BY seq ASC
  `;

  const hmemEntries = source.prepare(selectSql).all() as OldHmemEntry[];
  const idMap = new Map<string, string>();

  const run = () => {
    for (const hmem of hmemEntries) {
      const label = hmem.id;
      const existingLabel = findByLabel(store, label);

      if (existingLabel && options.deduplicate) {
        idMap.set(hmem.id, existingLabel);
        skipped++;
        conflicts.push({ label, action: 'merged', detail: existingLabel });
        continue;
      }

      let timId = hmem.id;
      if (entryExists(store, hmem.id) || (existingLabel && !options.deduplicate)) {
        timId = ulid();
        remapped++;
        conflicts.push({ label, action: 'remapped', detail: `${hmem.id} → ${timId}` });
      } else {
        newCount++;
      }

      idMap.set(hmem.id, timId);
      const accessedAt = hmem.updated_at ?? hmem.last_accessed ?? hmem.created_at;

      if (!options.dryRun) {
        insertEntryDirect(store.getDb(), {
          id: timId,
          parentId: null,
          content: hmem.level_1,
          depth: 1,
          confidence: hmem.obsolete ? 0.3 : hmem.favorite ? 1.0 : 0.9,
          createdAt: hmem.created_at,
          accessedAt,
          tags: hmem.favorite ? ['#favorite'] : [],
          irrelevant: hmem.irrelevant === 1,
          favorite: hmem.favorite === 1,
          metadata: {
            label,
            prefix: hmem.prefix,
            seq: hmem.seq,
            hmemId: hmem.id,
            hmemUid: hmem.id,
            importedAt: new Date().toISOString(),
          },
        });
        entriesImported++;

        const levels = [
          hmem.level_2,
          hmem.level_3,
          hmem.level_4,
          hmem.level_5,
        ].filter((l): l is string => !!l && l.trim().length > 0);

        let parentId = timId;
        for (let i = 0; i < levels.length; i++) {
          const childId = ulid();
          idMap.set(`${hmem.id}.${i + 2}`, childId);
          insertEntryDirect(store.getDb(), {
            id: childId,
            parentId,
            content: levels[i].trim(),
            depth: Math.min(i + 2, 5),
            confidence: 0.9,
            createdAt: hmem.created_at,
            accessedAt,
            tags: [],
            irrelevant: false,
            favorite: false,
            metadata: { hmemUid: childId, importedAt: new Date().toISOString() },
          });
          nodesImported++;
          parentId = childId;
          newCount++;
        }
      }

      if (hmem.links) {
        try {
          const links = JSON.parse(hmem.links) as string[];
          for (const target of links) {
            const src = idMap.get(hmem.id);
            const dst = idMap.get(target);
            if (!src || !dst) continue;
            if (!options.dryRun) {
              insertEdgeDirect(store.getDb(), src, dst, 'relates');
              edgesImported++;
            }
          }
        } catch {
          warnings.push(`Invalid links JSON on ${hmem.id}`);
        }
      }
    }
  };

  if (options.dryRun) {
    run();
  } else {
    const tx = store.getDb().transaction(run);
    tx();
  }

  return {
    entriesImported,
    nodesImported,
    edgesImported,
    skipped,
    remapped,
    conflicts,
    newCount,
    changedCount,
    warnings,
  };
}

export function tim_import(
  store: TimStore,
  sourcePath: string,
  options: ImportOptions = {},
): ImportReport {
  const info = inspectHmemFile(sourcePath);
  if (info.error) {
    return {
      sourcePath,
      format: 'unknown',
      dryRun: !!options.dryRun,
      entriesImported: 0,
      nodesImported: 0,
      edgesImported: 0,
      skipped: 0,
      remapped: 0,
      conflicts: [],
      newCount: 0,
      changedCount: 0,
      warnings: [info.error],
    };
  }

  if (info.format === 'unknown') {
    return {
      sourcePath,
      format: 'unknown',
      dryRun: !!options.dryRun,
      entriesImported: 0,
      nodesImported: 0,
      edgesImported: 0,
      skipped: 0,
      remapped: 0,
      conflicts: [],
      newCount: 0,
      changedCount: 0,
      warnings: ['Unknown hmem format'],
    };
  }

  const source = new Database(sourcePath, { readonly: true });
  try {
    const format = detectHmemFormat(source);
    const result = format === 'v2'
      ? importV2(source, store, options)
      : importOld(source, store, options);

    return {
      sourcePath,
      format,
      dryRun: !!options.dryRun,
      ...result,
    };
  } finally {
    source.close();
  }
}

export function labelFromMetadata(metadata: Record<string, unknown>): string | null {
  const label = metadata.label as string | undefined;
  if (label && parseLabel(label)) return label;
  const hmemId = metadata.hmemId as string | undefined;
  if (hmemId && parseLabel(hmemId)) return hmemId;
  return null;
}
