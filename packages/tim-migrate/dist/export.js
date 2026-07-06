"use strict";
// TIM Export — .hmem SQLite and markdown
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportToMarkdown = exportToMarkdown;
exports.exportToHmem = exportToHmem;
exports.tim_export = tim_export;
const hmem_format_js_1 = require("./hmem-format.js");
function rowToEntry(row) {
    return {
        id: row.id,
        parentId: row.parent_id,
        title: row.title ?? '',
        content: row.content,
        contentType: row.content_type,
        depth: row.depth,
        confidence: row.confidence,
        createdAt: row.created_at,
        accessedAt: row.accessed_at,
        updatedAt: row.updated_at,
        decayRate: row.decay_rate,
        visibility: row.visibility,
        tags: JSON.parse(row.tags),
        irrelevant: row.irrelevant === 1,
        favorite: row.favorite === 1,
        tombstonedAt: row.tombstoned_at,
        metadata: JSON.parse(row.metadata),
    };
}
function loadAllRows(store) {
    const db = store.getDb();
    return db.prepare(`
    SELECT * FROM entries
    WHERE tombstoned_at IS NULL
    ORDER BY created_at ASC
  `).all();
}
function loadAllEdges(store) {
    const db = store.getDb();
    const rows = db.prepare('SELECT * FROM edges').all();
    return rows.map(r => ({
        id: r.id,
        sourceId: r.source_id,
        targetId: r.target_id,
        type: r.type,
        weight: r.weight,
        metadata: JSON.parse(r.metadata),
    }));
}
function findRootId(rows, entryId) {
    let current = entryId;
    while (true) {
        const row = rows.get(current);
        if (!row || !row.parent_id)
            return current;
        current = row.parent_id;
    }
}
function resolveExportSet(rows, entryFilter) {
    const all = new Map(rows.map(r => [r.id, r]));
    if (!entryFilter)
        return new Set(rows.map(r => r.id));
    const included = new Set();
    for (const row of rows) {
        if (entryFilter(rowToEntry(row))) {
            let current = row.id;
            while (current) {
                included.add(current);
                const parentRow = all.get(current);
                current = parentRow?.parent_id ?? null;
            }
        }
    }
    return included;
}
function resolveLabel(entry, prefixCounters) {
    const meta = entry.metadata;
    const labelCandidate = meta.label ??
        meta.hmemId;
    if (labelCandidate) {
        const parsed = (0, hmem_format_js_1.parseLabel)(labelCandidate);
        if (parsed) {
            const current = prefixCounters.get(parsed.prefix) ?? 0;
            if (parsed.seq > current)
                prefixCounters.set(parsed.prefix, parsed.seq);
            return { label: labelCandidate, prefix: parsed.prefix, seq: parsed.seq };
        }
    }
    const prefix = meta.prefix ?? 'T';
    const seqFromMeta = meta.seq;
    let seq;
    if (seqFromMeta !== undefined) {
        seq = seqFromMeta;
    }
    else {
        seq = (prefixCounters.get(prefix) ?? 0) + 1;
    }
    prefixCounters.set(prefix, Math.max(prefixCounters.get(prefix) ?? 0, seq));
    return { label: (0, hmem_format_js_1.formatLabel)(prefix, seq), prefix, seq };
}
function siblingSeq(row, siblings) {
    const sorted = [...siblings].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    return sorted.findIndex(s => s.id === row.id) + 1;
}
function displayRef(entry) {
    const label = entry.metadata.label;
    return label ?? entry.id;
}
function renderMarkdownTree(entry, childrenByParent, edgesBySource, idToEntry) {
    const lines = [];
    const heading = '#'.repeat(Math.min(Math.max(entry.depth, 1), 6));
    const tagSuffix = entry.tags.length
        ? ' ' + entry.tags.filter(t => t.startsWith('#')).join(' ')
        : '';
    const firstLine = entry.title || entry.content.split('\n')[0];
    lines.push(`${heading} ${firstLine}${tagSuffix}`);
    const bodyLines = entry.title
        ? entry.content.split('\n')
        : entry.content.split('\n').slice(1);
    if (bodyLines.length > 0 && bodyLines.some(l => l.trim())) {
        lines.push('');
        lines.push(bodyLines.join('\n'));
    }
    const children = childrenByParent.get(entry.id) ?? [];
    for (const child of children) {
        lines.push('');
        lines.push(renderMarkdownTree(child, childrenByParent, edgesBySource, idToEntry));
    }
    const edges = edgesBySource.get(entry.id) ?? [];
    if (edges.length) {
        const refs = edges.map(e => {
            const target = idToEntry.get(e.targetId);
            return target ? `[${displayRef(target)}]` : `[${e.targetId}]`;
        });
        lines.push('');
        lines.push(`Related: ${refs.join(', ')}`);
    }
    return lines.join('\n');
}
function exportToMarkdown(store, options = {}) {
    const rows = loadAllRows(store);
    const exportIds = resolveExportSet(rows, options.entryFilter);
    const entries = rows
        .filter(r => exportIds.has(r.id))
        .map(rowToEntry);
    const childrenByParent = new Map();
    for (const entry of entries) {
        const parentKey = entry.parentId && exportIds.has(entry.parentId)
            ? entry.parentId
            : null;
        const list = childrenByParent.get(parentKey) ?? [];
        list.push(entry);
        childrenByParent.set(parentKey, list);
    }
    const idToEntry = new Map(entries.map(e => [e.id, e]));
    const edges = loadAllEdges(store).filter(e => exportIds.has(e.sourceId) && exportIds.has(e.targetId));
    const edgesBySource = new Map();
    for (const edge of edges) {
        const list = edgesBySource.get(edge.sourceId) ?? [];
        list.push(edge);
        edgesBySource.set(edge.sourceId, list);
    }
    const roots = (childrenByParent.get(null) ?? [])
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const parts = [
        `# TIM Export — ${new Date().toISOString()}`,
        '',
        `Entries: ${entries.length}, Edges: ${edges.length}`,
        '',
    ];
    for (const root of roots) {
        parts.push(renderMarkdownTree(root, childrenByParent, edgesBySource, idToEntry));
        parts.push('');
    }
    return parts.join('\n').trimEnd() + '\n';
}
function exportToHmem(store, targetPath, options = {}) {
    const rows = loadAllRows(store);
    const exportIds = resolveExportSet(rows, options.entryFilter);
    const rowMap = new Map(rows.map(r => [r.id, r]));
    const prefixCounters = new Map();
    const db = (0, hmem_format_js_1.createV2HmemDatabase)(targetPath);
    const insertEntry = db.prepare(`
    INSERT INTO entries (
      uid, label, prefix, seq, level_1, created_at, updated_at,
      access_count, last_accessed, obsolete, favorite, irrelevant, pinned, tags, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
    const insertNode = db.prepare(`
    INSERT INTO nodes (
      uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
    const insertLink = db.prepare(`
    INSERT OR IGNORE INTO links (src_uid, dst_uid, kind) VALUES (?, ?, ?)
  `);
    let entriesExported = 0;
    let nodesExported = 0;
    let linksExported = 0;
    const transaction = db.transaction(() => {
        const roots = rows.filter(r => !r.parent_id && exportIds.has(r.id));
        for (const root of roots) {
            const entry = rowToEntry(root);
            const { label, prefix, seq } = resolveLabel(entry, prefixCounters);
            insertEntry.run(root.id, label, prefix, seq, entry.title || root.content, root.created_at, root.accessed_at, 0, root.accessed_at, entry.confidence < 0.5 ? 1 : 0, root.favorite, root.irrelevant, 0, JSON.stringify(entry.tags));
            entriesExported++;
        }
        const children = rows.filter(r => r.parent_id && exportIds.has(r.id));
        const childrenByParent = new Map();
        for (const child of children) {
            const parentId = child.parent_id;
            const list = childrenByParent.get(parentId) ?? [];
            list.push(child);
            childrenByParent.set(parentId, list);
        }
        for (const child of children) {
            const entry = rowToEntry(child);
            const rootId = findRootId(rowMap, child.id);
            const parentUid = child.parent_id === rootId ? null : child.parent_id;
            const siblings = childrenByParent.get(child.parent_id) ?? [child];
            const seq = siblingSeq(child, siblings);
            insertNode.run(child.id, rootId, parentUid, child.depth, seq, entry.title || child.content, JSON.stringify(entry.tags), child.created_at, child.accessed_at, child.irrelevant);
            nodesExported++;
        }
        const edges = loadAllEdges(store).filter(e => exportIds.has(e.sourceId) && exportIds.has(e.targetId));
        for (const edge of edges) {
            insertLink.run(edge.sourceId, edge.targetId, edge.type);
            linksExported++;
        }
    });
    transaction();
    db.close();
    return { targetPath, entriesExported, nodesExported, linksExported };
}
function tim_export(store, targetPath, options = {}) {
    const format = options.format ?? 'hmem';
    if (format === 'text') {
        return exportToMarkdown(store, options);
    }
    if (!targetPath) {
        throw new Error('targetPath is required for hmem export');
    }
    return exportToHmem(store, targetPath, options);
}
//# sourceMappingURL=export.js.map