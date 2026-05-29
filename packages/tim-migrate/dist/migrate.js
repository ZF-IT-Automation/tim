"use strict";
// TIM Migration Engine — v0.1.0-alpha
// Converts hmem (.hmem SQLite) to TIM format.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateHmemToTim = migrateHmemToTim;
exports.verifyHmemFile = verifyHmemFile;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const tim_store_1 = require("tim-store");
function padSeq(seq) {
    return seq.toString().padStart(4, '0');
}
function buildContent(entry) {
    const parts = [];
    if (entry.title)
        parts.push(`# ${entry.title}`);
    if (entry.level_1)
        parts.push(entry.level_1);
    if (entry.level_2)
        parts.push(`\t${entry.level_2}`);
    if (entry.level_3)
        parts.push(`\t\t${entry.level_3}`);
    if (entry.level_4)
        parts.push(`\t\t\t${entry.level_4}`);
    if (entry.level_5)
        parts.push(`\t\t\t\t${entry.level_5}`);
    return parts.join('\n') || '(empty)';
}
function parseTags(entry, tagMap) {
    // Tags might be in a separate table or embedded
    // For old format, derive from prefix and content
    const tags = [];
    if (entry.prefix)
        tags.push(`#prefix:${entry.prefix.toLowerCase()}`);
    if (entry.favorite)
        tags.push('#favorite');
    if (entry.pinned)
        tags.push('#pinned');
    return tags;
}
/**
 * Migrate from OLD format hmem file to TIM.
 * Old format: prefix+seq IDs, level_1..5 content, no parent_id.
 */
async function migrateHmemToTim(sourcePath, targetPath) {
    const start = Date.now();
    const warnings = [];
    let entriesMigrated = 0;
    let edgesCreated = 0;
    const source = new better_sqlite3_1.default(sourcePath, { readonly: true });
    // Detect schema format
    const cols = source.prepare('PRAGMA table_info(memories)').all()
        .map(c => c.name);
    const isOldFormat = cols.includes('prefix') && cols.includes('seq');
    const isNewFormat = cols.includes('parent_id');
    if (!isOldFormat && !isNewFormat) {
        source.close();
        return {
            sourcePath, targetPath, entriesMigrated: 0, edgesCreated: 0,
            warnings: ['Unknown hmem format — neither old (prefix+seq) nor new (parent_id)'],
            duration: Date.now() - start, sourceEntryCount: 0,
        };
    }
    // Count entries
    const sourceEntryCount = source.prepare('SELECT COUNT(*) as c FROM memories').get().c;
    const target = new tim_store_1.TimStore(targetPath);
    try {
        if (isOldFormat) {
            const entries = source.prepare(`
        SELECT id, prefix, seq, created_at, level_1, level_2, level_3, level_4, level_5,
               last_accessed, links, obsolete, favorite, irrelevant, title, pinned, updated_at, active
        FROM memories
        ORDER BY seq ASC
      `).all();
            // First pass: create all entries as root-level
            const idMap = new Map(); // old ID → new ULID
            for (const hmem of entries) {
                try {
                    const content = buildContent(hmem);
                    const tags = parseTags(hmem, new Map());
                    // Calculate depth based on how many levels have content
                    let depth = 1;
                    if (hmem.level_2)
                        depth = 2;
                    if (hmem.level_3)
                        depth = 3;
                    if (hmem.level_4)
                        depth = 4;
                    if (hmem.level_5)
                        depth = 5;
                    const entry = await target.write(content, {
                        confidence: hmem.obsolete ? 0.3 : hmem.favorite ? 1.0 : 0.9,
                        tags,
                        visibility: 1,
                        metadata: {
                            hmemId: hmem.id,
                            hmemPrefix: hmem.prefix,
                            hmemSeq: hmem.seq,
                            migratedAt: new Date().toISOString(),
                        },
                    });
                    idMap.set(hmem.id, entry.id);
                    entriesMigrated++;
                }
                catch (err) {
                    warnings.push(`Failed to migrate entry ${hmem.id}: ${err.message}`);
                }
            }
            // Second pass: create edges from links
            for (const hmem of entries) {
                if (!hmem.links)
                    continue;
                try {
                    const links = JSON.parse(hmem.links);
                    const sourceULID = idMap.get(hmem.id);
                    if (!sourceULID)
                        continue;
                    for (const linkTarget of links) {
                        const targetULID = idMap.get(linkTarget);
                        if (targetULID) {
                            await target.link(sourceULID, targetULID, 'relates');
                            edgesCreated++;
                        }
                    }
                }
                catch {
                    // skip invalid links
                }
            }
            // Create hierarchy edges based on prefix grouping
            // Entries with same prefix and sequential seq → link as 'extends'
            let prevId = null;
            let prevPrefix = null;
            for (const hmem of entries) {
                const currentULID = idMap.get(hmem.id);
                if (!currentULID)
                    continue;
                if (prevPrefix === hmem.prefix && prevId && prevId !== currentULID) {
                    try {
                        await target.link(prevId, currentULID, 'extends');
                        edgesCreated++;
                    }
                    catch {
                        // skip
                    }
                }
                prevId = currentULID;
                prevPrefix = hmem.prefix;
            }
        }
    }
    finally {
        source.close();
    }
    const duration = Date.now() - start;
    return { sourcePath, targetPath, entriesMigrated, edgesCreated, warnings, duration, sourceEntryCount };
}
function verifyHmemFile(path) {
    try {
        const db = new better_sqlite3_1.default(path, { readonly: true });
        const count = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
        const cols = db.prepare('PRAGMA table_info(memories)').all()
            .map(c => c.name);
        const format = cols.includes('parent_id') ? 'new' : 'old';
        db.close();
        return { valid: true, entryCount: count, format };
    }
    catch (err) {
        return { valid: false, entryCount: 0, error: err.message };
    }
}
//# sourceMappingURL=migrate.js.map