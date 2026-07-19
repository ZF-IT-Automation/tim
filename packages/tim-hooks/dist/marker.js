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
exports.CWD_ONLY_MARKER_DISCOVERY_POLICY = exports.DEFAULT_MARKER_DISCOVERY_POLICY = exports.LOCK_TTL_MS = exports.ExclusiveMarkerConflictError = exports.INBOX_LABEL = exports.MARKER_VERSION = exports.CANONICAL_PROJECT_FILENAME = exports.MARKER_LOCK = exports.SUMMARIZER_LOCK = exports.MARKER_FILENAME = void 0;
exports.markerPath = markerPath;
exports.canonicalProjectPath = canonicalProjectPath;
exports.summarizerLockPath = summarizerLockPath;
exports.validateProjectLabel = validateProjectLabel;
exports.readMarker = readMarker;
exports.validateMarkerAgainstStore = validateMarkerAgainstStore;
exports.isUnsafeMarkerDir = isUnsafeMarkerDir;
exports.writeMarkerAtomic = writeMarkerAtomic;
exports.writeMarkerExclusive = writeMarkerExclusive;
exports.writeMarker = writeMarker;
exports.syncNearestProjectMarker = syncNearestProjectMarker;
exports.detectProject = detectProject;
exports.acquireLock = acquireLock;
exports.isSessionLocked = isSessionLocked;
exports.releaseLock = releaseLock;
exports.findMarkerOptionsFromEnv = findMarkerOptionsFromEnv;
exports.discoverMarker = discoverMarker;
exports.findMarker = findMarker;
exports.buildLoadDirective = buildLoadDirective;
exports.buildSessionDirective = buildSessionDirective;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto = __importStar(require("node:crypto"));
const constants_js_1 = require("./constants.js");
exports.MARKER_FILENAME = '.tim-project';
var constants_js_2 = require("./constants.js");
Object.defineProperty(exports, "SUMMARIZER_LOCK", { enumerable: true, get: function () { return constants_js_2.SUMMARIZER_LOCK; } });
Object.defineProperty(exports, "MARKER_LOCK", { enumerable: true, get: function () { return constants_js_2.MARKER_LOCK; } });
/**
 * Committed default project label for repos that gitignore `.tim-project`.
 * Contains only the stable `project` field. Override per-machine by creating
 * `.tim-project` in the repo root (it wins over tim.json).
 */
exports.CANONICAL_PROJECT_FILENAME = 'tim.json';
/**
 * Current marker schema version. Bump this when the on-disk shape changes;
 * readers detect older files by the missing/unknown `version` field and
 * normalize to the current shape.
 */
exports.MARKER_VERSION = 3;
function markerPath(cwd) {
    return path.join(cwd, exports.MARKER_FILENAME);
}
function canonicalProjectPath(cwd) {
    return path.join(cwd, exports.CANONICAL_PROJECT_FILENAME);
}
function summarizerLockPath(cwd) {
    return path.join(cwd, constants_js_1.TIM_META_DIR, constants_js_1.SUMMARIZER_LOCK);
}
/** Valid project labels: P/L/E/N + 4 digits (P0062, L0042, …). */
const PROJECT_LABEL_PATTERN = /^[PLEN]\d{4}$/;
/**
 * Shape-valid label that must never be written to `.tim-project`.
 * Used as a vitest fixture / corruption sentinel (see P9999 bug); DB
 * validation also rejects it when the project does not exist.
 */
const DENIED_MARKER_LABELS = new Set(['P9999']);
function validateProjectLabel(label) {
    if (DENIED_MARKER_LABELS.has(label))
        return false;
    return PROJECT_LABEL_PATTERN.test(label);
}
/**
 * Sentinel label for the Inbox project (P0000). Always treated as
 * valid even when not present in the DB — the Inbox is a system
 * project that tim-store.ensureInboxProject() materializes lazily.
 */
exports.INBOX_LABEL = 'P0000';
/**
 * Read a marker and normalize it to the current schema version.
 *
 * - Missing file → null
 * - Corrupt JSON → null
 * - v1/v2 file → `{ version: 3, project }` (runtime fields ignored)
 * - v3 file → returned as-is
 *
 * When no `.tim-project` exists, falls back to `tim.json` (committed
 * canonical default). A real `.tim-project` always wins — even when
 * corrupt (returns null rather than silently using tim.json).
 */
function readMarker(cwd) {
    const p = markerPath(cwd);
    if (fs.existsSync(p)) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
        catch {
            return null;
        }
        return normalizeMarker(raw);
    }
    return readCanonicalProject(cwd);
}
/**
 * Read the committed default project from tim.json.
 */
function readCanonicalProject(cwd) {
    const p = canonicalProjectPath(cwd);
    if (!fs.existsSync(p))
        return null;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== 'object')
        return null;
    const obj = raw;
    if (typeof obj.project !== 'string' || !PROJECT_LABEL_PATTERN.test(obj.project)) {
        console.warn(`[tim-hooks] ${exports.CANONICAL_PROJECT_FILENAME} has malformed project label ` +
            `"${String(obj.project)}" — expected ^[PLEN]\\d{4}$. Ignoring.`);
        return null;
    }
    return {
        version: exports.MARKER_VERSION,
        project: obj.project,
    };
}
/**
 * Coerce an unknown JSON value into a v3 ProjectMarker. Returns null if the
 * value isn't a usable marker (missing project, wrong type, or malformed label).
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
    return {
        version: exports.MARKER_VERSION,
        project: obj.project,
    };
}
/**
 * Defense-in-depth check: a project label that matches the
 * pattern but is semantically bogus (e.g. `P9999`) must NOT be persisted.
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
/**
 * Shared/system directories where a `.tim-project` must never live.
 */
function isUnsafeMarkerDir(dir) {
    let resolved = path.resolve(dir);
    try {
        resolved = fs.realpathSync(resolved);
    }
    catch { /* nonexistent — compare as-is */ }
    let tmp = path.resolve(os.tmpdir());
    try {
        tmp = fs.realpathSync(tmp);
    }
    catch { /* keep resolved */ }
    return resolved === tmp || resolved === path.parse(resolved).root;
}
/** Atomically write JSON to `filePath` (tmp + rename — no torn reads on POSIX). */
function writeMarkerAtomic(filePath, content) {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
}
class ExclusiveMarkerConflictError extends Error {
    filePath;
    constructor(filePath) {
        super(`Local marker already exists: ${filePath}`);
        this.filePath = filePath;
        this.name = 'ExclusiveMarkerConflictError';
    }
}
exports.ExclusiveMarkerConflictError = ExclusiveMarkerConflictError;
/** Publish a marker only when no local marker exists already. */
function writeMarkerExclusive(cwd, marker) {
    if (!validateProjectLabel(marker.project)) {
        throw new Error(`[tim-hooks] writeMarkerExclusive: refusing to write invalid project label "${marker.project}" — ` +
            `expected ^[PLEN]\\d{4}$ (P0062, L0042, …). Marker not written.`);
    }
    const filePath = markerPath(cwd);
    const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    const complete = { version: exports.MARKER_VERSION, project: marker.project };
    let ownsTemp = false;
    try {
        fs.writeFileSync(tmp, JSON.stringify(complete, null, 2), { flag: 'wx' });
        ownsTemp = true;
        try {
            fs.linkSync(tmp, filePath);
        }
        catch (err) {
            if (err.code === 'EEXIST') {
                throw new ExclusiveMarkerConflictError(filePath);
            }
            throw err;
        }
        return complete;
    }
    finally {
        if (ownsTemp) {
            try {
                fs.rmSync(tmp, { force: true });
            }
            catch {
                // Publication success or failure is authoritative; cleanup is best-effort.
            }
        }
    }
}
/** Write a project marker file. Always emits the current v3 schema. */
function writeMarker(cwd, marker) {
    if (isUnsafeMarkerDir(cwd)) {
        console.warn(`[tim-hooks] writeMarker: refusing to write ${exports.MARKER_FILENAME} in shared directory ` +
            `"${cwd}" (tmpdir / filesystem root). Marker not written — running markerless.`);
        return;
    }
    if (!validateProjectLabel(marker.project)) {
        console.warn(`[tim-hooks] writeMarker: refusing to write invalid project label "${marker.project}" — ` +
            `expected ^[PLEN]\\d{4}$ (P0062, L0042, …). Marker not written.`);
        return;
    }
    const p = markerPath(cwd);
    const upgraded = { version: exports.MARKER_VERSION, project: marker.project };
    writeMarkerAtomic(p, JSON.stringify(upgraded, null, 2));
}
/**
 * Update the nearest `.tim-project` (walk-up from cwd) after tim_load_project.
 */
function syncNearestProjectMarker(startCwd, projectLabel, options) {
    if (!validateProjectLabel(projectLabel)) {
        console.warn(`[tim-hooks] syncNearestProjectMarker: refusing to sync invalid project label ` +
            `"${projectLabel}" — expected ^[PLEN]\\d{4}$. Returning false.`);
        return false;
    }
    const located = discoverMarker(startCwd, {
        ...exports.DEFAULT_MARKER_DISCOVERY_POLICY,
        ...options?.findOptions,
    });
    if (!located)
        return false;
    writeMarker(located.dir, { project: projectLabel });
    return true;
}
/** Project detection — cwd-only marker (no walk-up). */
function detectProject(cwd) {
    return discoverMarker(cwd, exports.CWD_ONLY_MARKER_DISCOVERY_POLICY)?.marker ?? null;
}
var constants_js_3 = require("./constants.js");
Object.defineProperty(exports, "LOCK_TTL_MS", { enumerable: true, get: function () { return constants_js_3.LOCK_TTL_MS; } });
function acquireLock(cwd) {
    const lockDir = path.join(cwd, constants_js_1.TIM_META_DIR);
    const lock = summarizerLockPath(cwd);
    try {
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
        return true;
    }
    catch {
        try {
            const raw = JSON.parse(fs.readFileSync(lock, 'utf8'));
            if (Date.now() - raw.ts > constants_js_1.LOCK_TTL_MS) {
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
    const lock = summarizerLockPath(cwd);
    if (!fs.existsSync(lock))
        return false;
    try {
        const raw = JSON.parse(fs.readFileSync(lock, 'utf8'));
        return Date.now() - raw.ts <= constants_js_1.LOCK_TTL_MS;
    }
    catch {
        return true;
    }
}
function releaseLock(cwd) {
    try {
        fs.rmSync(summarizerLockPath(cwd), { force: true });
    }
    catch {
        /* ignore */
    }
}
/** Production default: walk-up from cwd, home ancestors allowed (statusline / sync paths). */
exports.DEFAULT_MARKER_DISCOVERY_POLICY = {
    walkUp: true,
    allowHome: true,
};
/** Cwd-only binding (session-start hook, checkpoint auto-load). */
exports.CWD_ONLY_MARKER_DISCOVERY_POLICY = {
    walkUp: false,
    allowHome: false,
};
function isInsideRoot(dir, root) {
    const d = path.resolve(dir);
    const r = path.resolve(root);
    return d === r || d.startsWith(r + path.sep);
}
/** Test helper: env vars override findMarker scope for spawned CLI. */
function findMarkerOptionsFromEnv() {
    const maxRoot = process.env.TIM_MARKER_MAX_ROOT?.trim();
    const walkUp = process.env.TIM_MARKER_WALK_UP === '1';
    const allowHome = process.env.TIM_MARKER_ALLOW_HOME === '1';
    if (!maxRoot && !walkUp && !allowHome)
        return undefined;
    return {
        ...(maxRoot ? { maxRoot } : {}),
        ...(walkUp ? { walkUp: true } : {}),
        ...(allowHome ? { allowHome: true } : {}),
    };
}
function isHomePath(dir) {
    return path.resolve(dir) === path.resolve(os.homedir());
}
function pickMarkerLocation(candidates) {
    return candidates.reduce((best, cur) => path.resolve(cur.dir).length > path.resolve(best.dir).length ? cur : best);
}
function scanDirForMarker(dir) {
    if (isUnsafeMarkerDir(dir))
        return null;
    if (fs.existsSync(markerPath(dir))) {
        const marker = readMarker(dir);
        if (!marker)
            return 'corrupt';
        return { marker, dir };
    }
    const canonical = readCanonicalProject(dir);
    if (canonical)
        return { marker: canonical, dir };
    return null;
}
/**
 * Find a project marker from `startCwd` — the single discovery implementation.
 */
function discoverMarker(startCwd, policy = exports.DEFAULT_MARKER_DISCOVERY_POLICY) {
    const walkUp = policy.walkUp ?? true;
    const allowHome = policy.allowHome ?? true;
    const startResolved = path.resolve(startCwd);
    if (!walkUp) {
        const result = scanDirForMarker(startResolved);
        if (result === 'corrupt')
            return null;
        return result;
    }
    const maxRoot = policy.maxRoot ? path.resolve(policy.maxRoot) : null;
    let dir = startResolved;
    const found = [];
    for (let i = 0; i < 256; i++) {
        const result = scanDirForMarker(dir);
        if (result === 'corrupt')
            return null;
        if (result)
            found.push(result);
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        if (maxRoot && isInsideRoot(dir, maxRoot) && !isInsideRoot(parent, maxRoot))
            break;
        dir = parent;
    }
    if (found.length === 0)
        return null;
    const filtered = found.filter((loc) => {
        if (allowHome)
            return true;
        if (!isHomePath(loc.dir))
            return true;
        return path.resolve(loc.dir) === startResolved;
    });
    if (filtered.length === 0)
        return null;
    return pickMarkerLocation(filtered);
}
/**
 * Back-compat wrapper: when `options` is omitted, cwd-only (historical default).
 */
function findMarker(startCwd, options) {
    if (!options) {
        return discoverMarker(startCwd, exports.CWD_ONLY_MARKER_DISCOVERY_POLICY);
    }
    return discoverMarker(startCwd, {
        walkUp: options.walkUp ?? false,
        allowHome: options.allowHome ?? false,
        ...(options.maxRoot ? { maxRoot: options.maxRoot } : {}),
    });
}
/**
 * Shared, harness-agnostic directive text. Every start hook emits exactly this.
 */
function buildLoadDirective(projectLabel, markerDir, bindingLabel) {
    const display = bindingLabel?.trim() || projectLabel;
    return [
        `📍 TIM project marker detected (.tim-project in ${markerDir}).`,
        `This session is bound to TIM project ${display}.`,
        ``,
        `ACTION: call tim_load_project(label="${projectLabel}") now to load the project ` +
            `brief from the TIM store, then run the tim-session-start skill. STEP 1 ` +
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
            `brief from the TIM store, then run the tim-session-start skill. STEP 1 ` +
            `is already decided by this TIM session — do NOT ask which project, and do NOT ` +
            `run any hmem/active-project cwd→project resolution. The TIM binding is authoritative ` +
            `for this turn.`,
    ].join('\n');
}
//# sourceMappingURL=marker.js.map