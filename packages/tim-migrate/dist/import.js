"use strict";
// TIM Import — .hmem SQLite → TIM store
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tim_import = tim_import;
exports.repairImportFlags = repairImportFlags;
exports.labelFromMetadata = labelFromMetadata;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const ulid_1 = require("ulid");
const tim_store_1 = require("tim-store");
const hmem_format_js_1 = require("./hmem-format.js");
function shouldMarkAsProjectRoot(prefix) {
    return prefix === 'P';
}
function readEntryMetadata(store, id) {
    const row = store.getDb().prepare('SELECT metadata FROM entries WHERE id = ?').get(id);
    return row?.metadata
        ? JSON.parse(row.metadata)
        : {};
}
function writeEntryMetadata(store, id, metadata) {
    store.getDb().prepare('UPDATE entries SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), new Date().toISOString(), id);
}
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
function hmemUidExists(store, hmemUid) {
    return store.getDb().prepare("SELECT id FROM entries WHERE json_extract(metadata, '$.hmemUid') = ? AND tombstoned_at IS NULL").get(hmemUid);
}
/** Re-read the row and enqueue an upsert staging record so imports sync. */
function stageEntryRow(db, id) {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!row)
        return;
    db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
    lww_timestamp, lww_device, lww_confidence)
    VALUES (?, 'entry', 'upsert', ?, ?, 'local', ?)`).run(id, JSON.stringify(row), Date.now(), Number(row.confidence ?? 1));
}
function insertEntryDirect(db, params) {
    const { title, body } = (0, tim_store_1.splitTitleBody)(params.content);
    db.prepare(`
    INSERT INTO entries (
      id, parent_id, title, content, content_type, depth, confidence,
      created_at, accessed_at, updated_at,
      decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata
    ) VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, ?, 0.0, 1, ?, ?, ?, NULL, ?)
  `).run(params.id, params.parentId, title, body, params.depth, params.confidence, params.createdAt, params.accessedAt, params.accessedAt, // updated_at: best available signal from the source
    JSON.stringify(params.tags), params.irrelevant ? 1 : 0, params.favorite ? 1 : 0, JSON.stringify(params.metadata));
    stageEntryRow(db, params.id);
}
function insertEdgeDirect(db, sourceId, targetId, type) {
    // The edges table has no UNIQUE(source,target,type) constraint — the ULID
    // primary key makes INSERT OR IGNORE useless against re-import duplicates.
    const dup = db.prepare('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND type = ? LIMIT 1').get(sourceId, targetId, type);
    if (dup)
        return false;
    const id = (0, ulid_1.ulid)();
    const ts = Date.now();
    const updatedAt = new Date(ts).toISOString();
    const result = db.prepare(`
    INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
    VALUES (?, ?, ?, ?, 1.0, '{}', ?)
  `).run(id, sourceId, targetId, type, updatedAt);
    if (result.changes === 0)
        return false; // duplicate — nothing new to sync
    const edgeRow = {
        id, source_id: sourceId, target_id: targetId,
        type, weight: 1.0, metadata: '{}', updated_at: updatedAt,
    };
    db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
    lww_timestamp, lww_device, lww_confidence)
    VALUES (?, 'edge', 'upsert', ?, ?, 'local', 1.0)`).run(`${sourceId}|${targetId}|${type}`, JSON.stringify(edgeRow), ts);
    return true;
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
    // All nodes including deleted ones: deleted nodes are never imported, but
    // their parent pointers are needed to reattach live descendants to the
    // nearest live ancestor instead of silently dropping whole subtrees.
    const hmemNodes = source.prepare(`
    SELECT uid, root_uid, parent_uid, depth, seq, content, tags,
           created_at, updated_at, irrelevant, deleted_at
    FROM nodes
    ORDER BY depth ASC, seq ASC
  `).all();
    const hmemLinks = source.prepare(`
    SELECT src_uid, dst_uid, kind FROM links
  `).all();
    const idMap = new Map();
    const planRoots = () => {
        for (const e of hmemEntries) {
            // Idempotency guard: if entry was already imported (same hmemUid), skip unless forced
            const alreadyImported = hmemUidExists(store, e.uid);
            if (alreadyImported && !options.force) {
                idMap.set(e.uid, alreadyImported.id);
                skipped++;
                conflicts.push({ label: e.label, action: 'merged', detail: alreadyImported.id });
                continue;
            }
            const existingLabel = findByLabel(store, e.label);
            const tags = e.tags ? JSON.parse(e.tags) : [];
            if (existingLabel && options.deduplicate) {
                idMap.set(e.uid, existingLabel);
                const { title, body } = (0, tim_store_1.splitTitleBody)(e.level_1);
                const shouldMarkProject = shouldMarkAsProjectRoot(e.prefix);
                const metadata = readEntryMetadata(store, existingLabel);
                const metadataNeedsRepair = shouldMarkProject && metadata.kind !== 'project';
                const contentNeedsUpdate = contentChanged(store, existingLabel, body);
                if (contentNeedsUpdate || metadataNeedsRepair) {
                    changedCount++;
                    if (!options.dryRun) {
                        const nextMetadata = metadataNeedsRepair
                            ? { ...metadata, kind: 'project' }
                            : metadata;
                        if (contentNeedsUpdate) {
                            store.getDb().prepare('UPDATE entries SET title = ?, content = ?, updated_at = ?, metadata = ? WHERE id = ?').run(title, body, new Date().toISOString(), JSON.stringify(nextMetadata), existingLabel);
                        }
                        else {
                            writeEntryMetadata(store, existingLabel, nextMetadata);
                        }
                        stageEntryRow(store.getDb(), existingLabel);
                    }
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
                    ...(shouldMarkAsProjectRoot(e.prefix) ? { kind: 'project' } : {}),
                    label: e.label,
                    prefix: e.prefix,
                    seq: e.seq,
                    hmemUid: e.uid,
                    pinned: e.pinned === 1,
                    importedAt: new Date().toISOString(),
                    // resolveProjectLabel/requireProject/ensureInboxProject match on kind=project
                    ...(e.prefix === 'P' && { kind: 'project' }),
                },
            });
            entriesImported++;
        }
    };
    const planNodes = () => {
        const nodeByUid = new Map(hmemNodes.map(n => [n.uid, n]));
        const liveNodes = hmemNodes.filter(n => n.deleted_at === null);
        // Guard pass first so children of already-imported nodes can attach.
        let pending = [];
        for (const n of liveNodes) {
            // Idempotency guard: if node was already imported (same hmemUid), skip unless forced
            const alreadyImported = hmemUidExists(store, n.uid);
            if (alreadyImported && !options.force) {
                idMap.set(n.uid, alreadyImported.id);
                skipped++;
                conflicts.push({ label: n.uid, action: 'merged', detail: alreadyImported.id });
                continue;
            }
            pending.push(n);
        }
        // Walk the parent chain through deleted nodes to the nearest live
        // ancestor; fall back to the root entry. 'defer' means a live ancestor
        // exists but is not mapped yet — retry in a later pass (handles nodes
        // whose depth/seq ordering puts them before their parent).
        const resolveParent = (n) => {
            let cur = n.parent_uid;
            const seen = new Set();
            while (cur && !seen.has(cur)) {
                seen.add(cur);
                const mapped = idMap.get(cur);
                if (mapped)
                    return mapped;
                const p = nodeByUid.get(cur);
                if (!p)
                    break; // unknown uid — fall back to root
                if (p.deleted_at !== null) {
                    cur = p.parent_uid;
                    continue;
                }
                return 'defer';
            }
            return idMap.get(n.root_uid) ?? null;
        };
        while (pending.length > 0) {
            const next = [];
            let progress = false;
            for (const n of pending) {
                const parentTimId = resolveParent(n);
                if (parentTimId === 'defer') {
                    next.push(n);
                    continue;
                }
                progress = true;
                if (parentTimId === null) {
                    warnings.push(`Skipped node ${n.uid}: root ${n.root_uid} not mapped`);
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
            if (!progress) {
                for (const n of next) {
                    warnings.push(`Skipped node ${n.uid}: unresolvable parent chain (${n.parent_uid})`);
                }
                break;
            }
            pending = next;
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
    const tableNames = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map(t => t.name));
    // Mid-generation old format: children live in memory_nodes (level_2..5 are
    // empty then) and tags in memory_tags. Both were silently dropped before.
    const tagsById = new Map();
    if (tableNames.has('memory_tags')) {
        const tagRows = source.prepare('SELECT entry_id, tag FROM memory_tags')
            .all();
        for (const row of tagRows) {
            const arr = tagsById.get(row.entry_id) ?? [];
            arr.push(row.tag);
            tagsById.set(row.entry_id, arr);
        }
    }
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
            // Idempotency guard: if entry was already imported (same hmemUid), skip unless forced
            const alreadyImported = hmemUidExists(store, hmem.id);
            if (alreadyImported && !options.force) {
                idMap.set(hmem.id, alreadyImported.id);
                skipped++;
                conflicts.push({ label: hmem.id, action: 'merged', detail: alreadyImported.id });
                continue;
            }
            const label = hmem.id;
            const existingLabel = findByLabel(store, label);
            if (existingLabel && options.deduplicate) {
                idMap.set(hmem.id, existingLabel);
                const shouldMarkProject = shouldMarkAsProjectRoot(hmem.prefix);
                const metadata = readEntryMetadata(store, existingLabel);
                const metadataNeedsRepair = shouldMarkProject && metadata.kind !== 'project';
                if (metadataNeedsRepair) {
                    changedCount++;
                    if (!options.dryRun) {
                        writeEntryMetadata(store, existingLabel, { ...metadata, kind: 'project' });
                        stageEntryRow(store.getDb(), existingLabel);
                    }
                }
                else {
                    skipped++;
                }
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
                    tags: [...new Set([
                            ...(hmem.favorite ? ['#favorite'] : []),
                            ...(tagsById.get(hmem.id) ?? []),
                        ])],
                    irrelevant: hmem.irrelevant === 1,
                    favorite: hmem.favorite === 1,
                    metadata: {
                        ...(shouldMarkAsProjectRoot(hmem.prefix) ? { kind: 'project' } : {}),
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
        if (tableNames.has('memory_nodes')) {
            const nodeCols = source.prepare('PRAGMA table_info(memory_nodes)').all()
                .map(c => c.name);
            const oldNodes = source.prepare(`
        SELECT id, parent_id, root_id, depth, seq, content, created_at,
               ${nodeCols.includes('updated_at') ? 'updated_at' : 'NULL as updated_at'},
               ${nodeCols.includes('favorite') ? 'favorite' : '0 as favorite'},
               ${nodeCols.includes('irrelevant') ? 'irrelevant' : '0 as irrelevant'}
        FROM memory_nodes
        ORDER BY depth ASC, seq ASC
      `).all();
            const nodeIds = new Set(oldNodes.map(n => n.id));
            let pending = [];
            for (const n of oldNodes) {
                const alreadyImported = hmemUidExists(store, n.id);
                if (alreadyImported && !options.force) {
                    idMap.set(n.id, alreadyImported.id);
                    skipped++;
                    conflicts.push({ label: n.id, action: 'merged', detail: alreadyImported.id });
                    continue;
                }
                pending.push(n);
            }
            // Multi-pass: a node whose parent is another node may appear before it
            // despite the depth/seq ordering; retry until no progress is made.
            while (pending.length > 0) {
                const next = [];
                let progress = false;
                for (const n of pending) {
                    let parentTimId = idMap.get(n.parent_id);
                    if (!parentTimId) {
                        if (nodeIds.has(n.parent_id)) {
                            next.push(n); // parent is a node not mapped yet
                            continue;
                        }
                        parentTimId = idMap.get(n.root_id);
                    }
                    progress = true;
                    if (!parentTimId) {
                        warnings.push(`Skipped node ${n.id}: root ${n.root_id} not mapped`);
                        continue;
                    }
                    let timId = n.id;
                    if (entryExists(store, n.id)) {
                        timId = (0, ulid_1.ulid)();
                        remapped++;
                        conflicts.push({ label: n.id, action: 'remapped', detail: `${n.id} → ${timId}` });
                    }
                    else {
                        newCount++;
                    }
                    idMap.set(n.id, timId);
                    if (options.dryRun)
                        continue;
                    insertEntryDirect(store.getDb(), {
                        id: timId,
                        parentId: parentTimId,
                        content: n.content,
                        depth: Math.min(Math.max(n.depth, 2), 5),
                        confidence: 0.9,
                        createdAt: n.created_at,
                        accessedAt: n.updated_at ?? n.created_at,
                        tags: tagsById.get(n.id) ?? [],
                        irrelevant: n.irrelevant === 1,
                        favorite: n.favorite === 1,
                        metadata: {
                            hmemUid: n.id,
                            importedAt: new Date().toISOString(),
                        },
                    });
                    nodesImported++;
                }
                if (!progress) {
                    for (const n of next) {
                        warnings.push(`Skipped node ${n.id}: unresolvable parent chain (${n.parent_id})`);
                    }
                    break;
                }
                pending = next;
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
/**
 * Repair irrelevant/favorite flags (and empty tags) on already-imported
 * entries from the source .hmem file, matched via metadata.hmemUid.
 *
 * Motivation: the 2026-05-30 production migration wrote inverted flags —
 * nearly every imported entry landed with irrelevant=1, hiding the entire
 * hmem heritage from every TIM tool. The source file is authoritative for
 * these mirror entries. Repaired rows are staged so the fix syncs.
 */
function repairImportFlags(store, sourcePath, options = {}) {
    const warnings = [];
    const info = (0, hmem_format_js_1.inspectHmemFile)(sourcePath);
    if (info.error || info.format === 'unknown') {
        return {
            sourcePath,
            format: 'unknown',
            dryRun: !!options.dryRun,
            matched: 0,
            repaired: 0,
            warnings: [info.error ?? 'Unknown hmem format'],
        };
    }
    const flagsByUid = new Map();
    const source = new better_sqlite3_1.default(sourcePath, { readonly: true });
    const format = (0, hmem_format_js_1.detectHmemFormat)(source);
    try {
        if (format === 'v2') {
            const entries = source.prepare('SELECT uid, irrelevant, favorite, tags FROM entries WHERE deleted_at IS NULL').all();
            for (const e of entries) {
                flagsByUid.set(e.uid, {
                    irrelevant: e.irrelevant === 1,
                    favorite: e.favorite === 1,
                    tags: e.tags ? JSON.parse(e.tags) : [],
                });
            }
            const nodes = source.prepare('SELECT uid, irrelevant, tags FROM nodes WHERE deleted_at IS NULL').all();
            for (const n of nodes) {
                flagsByUid.set(n.uid, {
                    irrelevant: n.irrelevant === 1,
                    favorite: false,
                    tags: n.tags ? JSON.parse(n.tags) : [],
                });
            }
        }
        else {
            const memories = source.prepare('SELECT id, irrelevant, favorite FROM memories').all();
            for (const m of memories) {
                flagsByUid.set(m.id, { irrelevant: m.irrelevant === 1, favorite: m.favorite === 1, tags: [] });
            }
            const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
                .map(t => t.name));
            if (tables.has('memory_tags')) {
                const tagRows = source.prepare('SELECT entry_id, tag FROM memory_tags')
                    .all();
                for (const row of tagRows) {
                    const f = flagsByUid.get(row.entry_id);
                    if (f)
                        f.tags.push(row.tag);
                }
            }
            if (tables.has('memory_nodes')) {
                const nodeCols = source.prepare('PRAGMA table_info(memory_nodes)').all()
                    .map(c => c.name);
                const nodes = source.prepare(`
          SELECT id,
                 ${nodeCols.includes('irrelevant') ? 'irrelevant' : '0 as irrelevant'},
                 ${nodeCols.includes('favorite') ? 'favorite' : '0 as favorite'}
          FROM memory_nodes
        `).all();
                for (const n of nodes) {
                    flagsByUid.set(n.id, { irrelevant: n.irrelevant === 1, favorite: n.favorite === 1, tags: [] });
                }
            }
        }
    }
    finally {
        source.close();
    }
    const db = store.getDb();
    const rows = db.prepare(`
    SELECT id, irrelevant, favorite, tags,
           json_extract(metadata, '$.hmemUid') AS hmemUid
    FROM entries
    WHERE json_extract(metadata, '$.hmemUid') IS NOT NULL AND tombstoned_at IS NULL
  `).all();
    let matched = 0;
    let repaired = 0;
    const update = db.prepare('UPDATE entries SET irrelevant = ?, favorite = ?, tags = ?, updated_at = ? WHERE id = ?');
    const tx = db.transaction(() => {
        for (const row of rows) {
            const src = flagsByUid.get(row.hmemUid);
            if (!src)
                continue; // deleted or unknown in source — leave TIM row untouched
            matched++;
            const wantIrrelevant = src.irrelevant ? 1 : 0;
            const wantFavorite = src.favorite ? 1 : 0;
            let curTags = [];
            try {
                curTags = row.tags ? JSON.parse(row.tags) : [];
            }
            catch {
                warnings.push(`Invalid tags JSON on ${row.id}; treating as empty`);
            }
            // Tags: only fill in when TIM lost them entirely — never overwrite
            // tags that were added in TIM after the import.
            const wantTags = curTags.length === 0 && src.tags.length > 0 ? src.tags : curTags;
            const tagsChanged = wantTags !== curTags;
            if (row.irrelevant === wantIrrelevant && row.favorite === wantFavorite && !tagsChanged) {
                continue;
            }
            repaired++;
            if (options.dryRun)
                continue;
            update.run(wantIrrelevant, wantFavorite, JSON.stringify(wantTags), new Date().toISOString(), row.id);
            stageEntryRow(db, row.id);
        }
    });
    tx();
    return {
        sourcePath,
        format,
        dryRun: !!options.dryRun,
        matched,
        repaired,
        warnings,
    };
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