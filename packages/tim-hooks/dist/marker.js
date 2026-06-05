"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCK_TTL_MS = exports.INBOX_LABEL = exports.MARKER_VERSION = exports.MARKER_LOCK = exports.MARKER_FILENAME = void 0;
exports.markerPath = markerPath;
exports.readMarker = readMarker;
exports.validateMarkerAgainstStore = validateMarkerAgainstStore;
exports.writeMarker = writeMarker;
exports.syncNearestProjectMarker = syncNearestProjectMarker;
exports.detectProject = detectProject;
exports.reconcileMarker = reconcileMarker;
exports.acquireLock = acquireLock;
exports.isSessionLocked = isSessionLocked;
exports.releaseLock = releaseLock;
exports.findMarkerOptionsFromEnv = findMarkerOptionsFromEnv;
exports.findMarker = findMarker;
exports.buildLoadDirective = buildLoadDirective;
exports.buildSessionDirective = buildSessionDirective;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tim_store_1 = require("tim-store");
exports.MARKER_FILENAME = '.tim-project';
exports.MARKER_LOCK = '.tim-project.lock';
/**
 * Current marker schema version. Bump this when the on-disk shape changes;
 * readers detect older files by the missing/unknown `version` field and
 * normalize to the current shape.
 */
exports.MARKER_VERSION = 2;
function markerPath(cwd) {
    return path.join(cwd, exports.MARKER_FILENAME);
}
/**
 * Read a marker and normalize it to the current schema version.
 *
 * - Missing file → null
 * - Corrupt JSON → null
 * - v1 file (no `version` field) → strips `route_exchanges_to` + `sessions`
 *   map, sets `version: 2`, returns the upgraded object. The file itself
 *   is NOT rewritten here — the next `writeMarker` call upgrades it.
 * - v2 file → returned as-is.
 *
 * Callers always see a v2-conformant `ProjectMarker` regardless of what's
 * on disk. This is the only safe way to evolve the schema without forcing
 * a one-shot migration.
 */
function readMarker(cwd) {
    const p = markerPath(cwd);
    if (!fs.existsSync(p))
        return null;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
    return normalizeMarker(raw);
}
/**
 * Whitelist for valid project labels in .tim-project. P = Project,
 * L = Learning, E = Error, N = Note — same shape TIM uses everywhere
 * (P0062, L0042, E0031, N0014). A corrupt or out-of-schema label here
 * silently poisons the whole session-binding pipeline (statusline,
 * hooks, load_project), so we reject anything that doesn't match.
 */
const PROJECT_LABEL_PATTERN = /^[PLEN]\d{4}$/;
/**
 * Sentinel label for the Inbox project (P0000). Always treated as
 * valid even when not present in the DB — the Inbox is a system
 * project that tim-store.ensureInboxProject() materializes lazily.
 */
exports.INBOX_LABEL = 'P0000';
/**
 * Coerce an unknown JSON value into a v2 ProjectMarker. Strips legacy
 * fields. Returns null if the value isn't a usable marker (missing
 * project/session, wrong types, or malformed project label).
 *
 * NOTE: This is the pure-FS reader. The DB-existence check
 * (project label must resolve to a real entry in the TIM DB) lives
 * in `validateMarkerAgainstStore` — called from the two write-side
 * paths (runSessionStart, syncNearestProjectMarker) before they
 * persist anything. We deliberately keep the disk reader free of
 * DB dependencies so hooks under a tight timeout can still parse
 * the marker without paying for an SQLite roundtrip.
 */
function normalizeMarker(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const obj = raw;
    if (typeof obj.project !== 'string' || obj.project.length === 0)
        return null;
    if (!PROJECT_LABEL_PATTERN.test(obj.project)) {
        console.warn(`[tim-hooks] .tim-project has malformed project label "${obj.project}" — ` +
            `expected ^[PLEN]\\d{4}$ (P0062, L0042, …). Ignoring marker.`);
        return null;
    }
    if (typeof obj.session !== 'string')
        return null;
    if (typeof obj.exchanges !== 'number' || !Number.isFinite(obj.exchanges))
        return null;
    if (typeof obj.batch_size !== 'number' || !Number.isFinite(obj.batch_size))
        return null;
    if (typeof obj.batches_summarized !== 'number' || !Number.isFinite(obj.batches_summarized)) {
        return null;
    }
    return {
        version: exports.MARKER_VERSION,
        project: obj.project,
        session: obj.session,
        exchanges: obj.exchanges,
        batch_size: obj.batch_size,
        batches_summarized: obj.batches_summarized,
    };
}
/**
 * Defense-in-depth check: a project label that matches the
 * pattern but is semantically bogus (e.g. `P9999` — a label that
 * was never issued by TIM, often the residue of a hand-edit or a
 * botched commit) must NOT be persisted into `.tim-project`. The
 * original P9999 bug bound the statusline to a non-existent
 * project because the file was trusted blindly.
 *
 * Resolution: pattern-match (already enforced by normalizeMarker)
 * AND the project must exist as a `kind=project` entry in the DB.
 * The Inbox (P0000) is exempt — it's a system project that
 * tim-store creates on first use via `ensureInboxProject`.
 *
 * Returns the marker on success, null on rejection. On DB error
 * (store unavailable, DB locked, etc.) we FAIL OPEN: a corrupted
 * DB is not a license to corrupt the marker, but a transient
 * read failure shouldn't brick the session-start hook. The
 * pattern check in normalizeMarker still ran, so we never accept
 * malformed labels — we just skip the existence confirmation.
 */
async function validateMarkerAgainstStore(marker, store) {
    if (marker.project === exports.INBOX_LABEL)
        return marker;
    let resolved;
    try {
        resolved = await store.resolveProjectLabel(marker.project);
    }
    catch (err) {
        console.warn(`[tim-hooks] .tim-project validation: DB lookup for "${marker.project}" ` +
            `failed (${err.message ?? err}) — accepting on pattern match only.`);
        return marker;
    }
    if (resolved.status === 'found') {
        return { ...marker, project: resolved.label };
    }
    console.warn(`[tim-hooks] .tim-project has pattern-valid project label "${marker.project}" ` +
        `but no matching entry exists in the DB. Treating as corrupt.`);
    return null;
}
/** Write a project marker file. Always emits the current schema version:
 *  the on-disk file becomes v2 on first write, regardless of the caller's
 *  input. This is the auto-upgrade path for v1 files. */
function writeMarker(cwd, marker) {
    const p = markerPath(cwd);
    const upgraded = { ...marker, version: exports.MARKER_VERSION };
    fs.writeFileSync(p, JSON.stringify(upgraded, null, 2));
}
/**
 * Update the nearest `.tim-project` (walk-up from cwd) after tim_load_project.
 * Statusline and hooks read this marker — must match the loaded project label.
 */
function syncNearestProjectMarker(startCwd, projectLabel, options) {
    const located = findMarker(startCwd, options?.findOptions);
    if (!located)
        return false;
    const sessionId = options?.sessionId?.trim();
    const { version: _v, ...rest } = located.marker;
    writeMarker(located.dir, {
        ...rest,
        project: projectLabel,
        ...(sessionId ? { session: sessionId } : {}),
    });
    return true;
}
/** Project detection — v1: .tim-project marker only. */
function detectProject(cwd) {
    return readMarker(cwd);
}
/** Re-derive counters from the DB and persist them into the marker. */
async function reconcileMarker(store, cwd) {
    const marker = readMarker(cwd);
    if (!marker)
        throw new Error(`No ${exports.MARKER_FILENAME} in ${cwd}`);
    const { exchangeCount, batchesSummarized } = await (0, tim_store_1.deriveCounters)(store, marker.session);
    const reconciled = {
        ...marker,
        exchanges: exchangeCount,
        batches_summarized: batchesSummarized,
    };
    writeMarker(cwd, reconciled);
    // Read back to return the canonical v2 shape (writeMarker upgraded the file).
    return readMarker(cwd) ?? reconciled;
}
exports.LOCK_TTL_MS = 10 * 60_000;
function acquireLock(cwd) {
    const lock = path.join(cwd, exports.MARKER_LOCK);
    try {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
        return true;
    }
    catch {
        try {
            const raw = JSON.parse(fs.readFileSync(lock, 'utf8'));
            if (Date.now() - raw.ts > exports.LOCK_TTL_MS) {
                fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
                return true;
            }
        }
        catch {
            /* unreadable lock → treat as held */
        }
        return false;
    }
}
/** True when an active (non-stale) summarizer/session lock is held. */
function isSessionLocked(cwd) {
    const lock = path.join(cwd, exports.MARKER_LOCK);
    if (!fs.existsSync(lock))
        return false;
    try {
        const raw = JSON.parse(fs.readFileSync(lock, 'utf8'));
        return Date.now() - raw.ts <= exports.LOCK_TTL_MS;
    }
    catch {
        return true;
    }
}
function releaseLock(cwd) {
    try {
        fs.rmSync(path.join(cwd, exports.MARKER_LOCK), { force: true });
    }
    catch {
        /* ignore */
    }
}
function isInsideRoot(dir, root) {
    const d = path.resolve(dir);
    const r = path.resolve(root);
    return d === r || d.startsWith(r + path.sep);
}
/** Test helper: TIM_MARKER_MAX_ROOT limits walk-up scope for spawned CLI. */
function findMarkerOptionsFromEnv() {
    const maxRoot = process.env.TIM_MARKER_MAX_ROOT?.trim();
    return maxRoot ? { maxRoot } : undefined;
}
function pickMarkerLocation(candidates) {
    const homeDir = path.resolve(os.homedir());
    const nonHome = candidates.filter((loc) => path.resolve(loc.dir) !== homeDir);
    const pool = nonHome.length > 0 ? nonHome : candidates;
    return pool.reduce((best, cur) => path.resolve(cur.dir).length > path.resolve(best.dir).length ? cur : best);
}
/**
 * Walk up from `startCwd` and return the deepest `.tim-project` on that chain.
 * When both a repo marker and `~/.tim-project` exist, the home marker is skipped.
 * Pure FS — no store, no network — safe for hooks under a tight timeout.
 *
 * If a marker FILE exists but is unparseable, we STOP and return null rather than
 * silently binding an ancestor's project.
 */
function findMarker(startCwd, options) {
    const maxRoot = options?.maxRoot ? path.resolve(options.maxRoot) : null;
    let dir = path.resolve(startCwd);
    const found = [];
    for (let i = 0; i < 256; i++) {
        if (fs.existsSync(markerPath(dir))) {
            const marker = readMarker(dir); // null when corrupt
            if (!marker)
                return null;
            found.push({ marker, dir });
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break; // reached the filesystem root
        if (maxRoot && isInsideRoot(dir, maxRoot) && !isInsideRoot(parent, maxRoot))
            break;
        dir = parent;
    }
    return found.length > 0 ? pickMarkerLocation(found) : null;
}
/**
 * Shared, harness-agnostic directive text. Every start hook (Hermes,
 * Claude Code, Cursor) emits exactly this so wording stays DRY. The TIM
 * marker is authoritative for project binding this turn (see plan §end-state).
 */
function buildLoadDirective(projectLabel, markerDir, bindingLabel) {
    const display = bindingLabel?.trim() || projectLabel;
    return [
        `📍 TIM project marker detected (.tim-project in ${markerDir}).`,
        `This session is bound to TIM project ${display}.`,
        ``,
        `ACTION: call tim_load_project(label="${projectLabel}") now to load the project ` +
            `brief from the TIM store, then run the o9k-session-start skill. STEP 1 ` +
            `(project binding) is already decided by this marker — do NOT ask which ` +
            `project, and do NOT run any hmem/active-project cwd→project resolution. ` +
            `The TIM marker is authoritative for this turn.`,
    ].join('\n');
}
/** Directive when project comes from TIM session metadata (no local .tim-project). */
function buildSessionDirective(projectLabel, cwd, bindingLabel) {
    const display = bindingLabel?.trim() || projectLabel;
    return [
        `📍 TIM session bound to project ${display} (TIM store, cwd ${cwd}).`,
        `This session is bound to TIM project ${display}.`,
        ``,
        `ACTION: call tim_load_project(label="${projectLabel}") now to load the project ` +
            `brief from the TIM store, then run the o9k-session-start skill. STEP 1 ` +
            `is already decided by this TIM session — do NOT ask which project, and do NOT ` +
            `run any hmem/active-project cwd→project resolution. The TIM binding is authoritative ` +
            `for this turn.`,
    ].join('\n');
}
//# sourceMappingURL=marker.js.map