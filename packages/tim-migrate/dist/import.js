"use strict";
// TIM Import — .hmem SQLite → TIM store
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tim_import = tim_import;
exports.labelFromMetadata = labelFromMetadata;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const ulid_1 = require("ulid");
const hmem_format_js_1 = require("./hmem-format.js");
function findByLabel(store, label) {
    const row = store.getDb().prepare("SELECT id FROM entries WHERE json_extract(metadata, '$.label') = ? AND tombstoned_at IS NULL").get(label);
    return row?.id ?? null;
}
function entryExists(store, id) {
    const row = store.getDb().prepare('SELECT id FROM entries WHERE id = ? AND tombstoned_at IS NULL').get(id);
    return !!row;
}
function contentChanged(store, id, content) {
    const row = store.getDb().prepare('SELECT content FROM entries WHERE id = ?').get(id);
    return !!row && row.content !== content;
}
function insertEntryDirect(db, params) {
    db.prepare(`
    INSERT INTO entries (
      id, parent_id, content, content_type, depth, confidence, created_at, accessed_at,
      decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata
    ) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, 0.0, 1, ?, ?, ?, NULL, ?)
  `).run(params.id, params.parentId, params.content, params.depth, params.confidence, params.createdAt, params.accessedAt, JSON.stringify(params.tags), params.irrelevant ? 1 : 0, params.favorite ? 1 : 0, JSON.stringify(params.metadata));
}
function insertEdgeDirect(db, sourceId, targetId, type) {
    db.prepare(`
    INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, metadata)
    VALUES (?, ?, ?, ?, 1.0, '{}')
  `).run((0, ulid_1.ulid)(), sourceId, targetId, type);
}
function importV2(source, store, options) {
    const warnings = [];
    const conflicts = [];
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
  `).all();
    const hmemNodes = source.prepare(`
    SELECT uid, root_uid, parent_uid, depth, seq, content, tags,
           created_at, updated_at, irrelevant, deleted_at
    FROM nodes
    WHERE deleted_at IS NULL
    ORDER BY depth ASC, seq ASC
  `).all();
    const hmemLinks = source.prepare(`
    SELECT src_uid, dst_uid, kind FROM links
  `).all();
    const idMap = new Map();
    const mergedRoots = new Set();
    const planRoots = () => {
        for (const e of hmemEntries) {
            const existingLabel = findByLabel(store, e.label);
            const tags = e.tags ? JSON.parse(e.tags) : [];
            if (existingLabel && options.deduplicate) {
                idMap.set(e.uid, existingLabel);
                mergedRoots.add(e.uid);
                if (contentChanged(store, existingLabel, e.level_1)) {
                    changedCount++;
                }
                else {
                    skipped++;
                }
                conflicts.push({ label: e.label, action: 'merged', detail: existingLabel });
                continue;
            }
            let timId = e.uid;
            if (entryExists(store, e.uid) || (existingLabel && !options.deduplicate)) {
                timId = (0, ulid_1.ulid)();
                remapped++;
                conflicts.push({
                    label: e.label,
                    action: 'remapped',
                    detail: `${e.uid} → ${timId}`,
                });
            }
            else {
                newCount++;
            }
            idMap.set(e.uid, timId);
            if (options.dryRun)
                continue;
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
                timId = (0, ulid_1.ulid)();
                remapped++;
                conflicts.push({
                    label: n.uid,
                    action: 'remapped',
                    detail: `${n.uid} → ${timId}`,
                });
            }
            else {
                newCount++;
            }
            idMap.set(n.uid, timId);
            const tags = n.tags ? JSON.parse(n.tags) : [];
            if (options.dryRun)
                continue;
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
            if (options.dryRun)
                continue;
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
    }
    else {
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
function importOld(source, store, options) {
    const warnings = [];
    const conflicts = [];
    let entriesImported = 0;
    let nodesImported = 0;
    let edgesImported = 0;
    let skipped = 0;
    let remapped = 0;
    let newCount = 0;
    let changedCount = 0;
    const cols = source.prepare('PRAGMA table_info(memories)').all()
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
    const hmemEntries = source.prepare(selectSql).all();
    const idMap = new Map();
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
                timId = (0, ulid_1.ulid)();
                remapped++;
                conflicts.push({ label, action: 'remapped', detail: `${hmem.id} → ${timId}` });
            }
            else {
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
                ].filter((l) => !!l && l.trim().length > 0);
                let parentId = timId;
                for (let i = 0; i < levels.length; i++) {
                    const childId = (0, ulid_1.ulid)();
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
                    const links = JSON.parse(hmem.links);
                    for (const target of links) {
                        const src = idMap.get(hmem.id);
                        const dst = idMap.get(target);
                        if (!src || !dst)
                            continue;
                        if (!options.dryRun) {
                            insertEdgeDirect(store.getDb(), src, dst, 'relates');
                            edgesImported++;
                        }
                    }
                }
                catch {
                    warnings.push(`Invalid links JSON on ${hmem.id}`);
                }
            }
        }
    };
    if (options.dryRun) {
        run();
    }
    else {
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
function tim_import(store, sourcePath, options = {}) {
    const info = (0, hmem_format_js_1.inspectHmemFile)(sourcePath);
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
    const source = new better_sqlite3_1.default(sourcePath, { readonly: true });
    try {
        const format = (0, hmem_format_js_1.detectHmemFormat)(source);
        const result = format === 'v2'
            ? importV2(source, store, options)
            : importOld(source, store, options);
        return {
            sourcePath,
            format,
            dryRun: !!options.dryRun,
            ...result,
        };
    }
    finally {
        source.close();
    }
}
function labelFromMetadata(metadata) {
    const label = metadata.label;
    if (label && (0, hmem_format_js_1.parseLabel)(label))
        return label;
    const hmemId = metadata.hmemId;
    if (hmemId && (0, hmem_format_js_1.parseLabel)(hmemId))
        return hmemId;
    return null;
}
//# sourceMappingURL=import.js.map