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
const vitest_1 = require("vitest");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const marker_js_1 = require("../marker.js");
const tim_store_1 = require("tim-store");
/** Outside ~ so findMarker walk-up does not hit real ~/.tim-project */
const TEST_ROOT = '/tmp/tim-test-runs';
(0, vitest_1.describe)('marker', () => {
    let dir;
    (0, vitest_1.beforeEach)(() => {
        fs.mkdirSync(TEST_ROOT, { recursive: true });
        dir = fs.mkdtempSync(path.join(TEST_ROOT, 'marker-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('round-trips a marker file', () => {
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0001',
            session: 's1',
            exchanges: 3,
            batch_size: 5,
            batches_summarized: 0,
        });
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)).toMatchObject({ project: 'P0001', session: 's1', exchanges: 3 });
    });
    (0, vitest_1.it)('detectProject prefers the .tim-project marker', () => {
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0009',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
        (0, vitest_1.expect)((0, marker_js_1.detectProject)(dir)?.project).toBe('P0009');
    });
    (0, vitest_1.it)('detectProject returns null when no marker exists', () => {
        (0, vitest_1.expect)((0, marker_js_1.detectProject)(dir)).toBeNull();
    });
    (0, vitest_1.it)('reconcileMarker overwrites cached counters with DB-derived values', async () => {
        const store = new tim_store_1.TimStore(':memory:');
        const sessions = new tim_store_1.SessionManager(store);
        await store.createProject('P0002');
        await sessions.startProjectSession({
            sessionId: 'sm',
            projectId: 'P0002',
            agentName: 'a',
            cwd: dir,
            harness: 't',
            batchSize: 2,
        });
        await sessions.logExchange('sm', [
            { role: 'user', content: 'q' },
            { role: 'agent', content: 'a' },
        ]);
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0002',
            session: 'sm',
            exchanges: 99,
            batch_size: 2,
            batches_summarized: 7,
        });
        const reconciled = await (0, marker_js_1.reconcileMarker)(store, dir);
        (0, vitest_1.expect)(reconciled.exchanges).toBe(1);
        (0, vitest_1.expect)(reconciled.batches_summarized).toBe(0);
        store.close();
    });
    (0, vitest_1.it)('acquireLock single-flights: second acquire fails while the lock is fresh', () => {
        (0, vitest_1.expect)((0, marker_js_1.acquireLock)(dir)).toBe(true);
        (0, vitest_1.expect)((0, marker_js_1.acquireLock)(dir)).toBe(false);
        (0, marker_js_1.releaseLock)(dir);
        (0, vitest_1.expect)((0, marker_js_1.acquireLock)(dir)).toBe(true);
    });
    (0, vitest_1.it)('findMarker returns the marker in the cwd itself', () => {
        (0, marker_js_1.writeMarker)(dir, { project: 'P0001', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const found = (0, marker_js_1.findMarker)(dir, { maxRoot: dir });
        (0, vitest_1.expect)(found?.marker.project).toBe('P0001');
        (0, vitest_1.expect)(found?.dir).toBe(fs.realpathSync(dir));
    });
    (0, vitest_1.it)('findMarker walks up to a parent marker', () => {
        (0, marker_js_1.writeMarker)(dir, { project: 'P0002', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const sub = path.join(dir, 'a', 'b', 'c');
        fs.mkdirSync(sub, { recursive: true });
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })?.marker.project).toBe('P0002');
    });
    (0, vitest_1.it)('findMarker: nearest marker wins over an ancestor', () => {
        (0, marker_js_1.writeMarker)(dir, { project: 'P0002', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const sub = path.join(dir, 'child');
        fs.mkdirSync(sub, { recursive: true });
        (0, marker_js_1.writeMarker)(sub, { project: 'P0003', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })?.marker.project).toBe('P0003');
    });
    (0, vitest_1.it)('findMarker: repo marker wins over ~/.tim-project on the same walk chain', () => {
        const fakeHome = path.join(dir, 'fake-home');
        const repo = path.join(fakeHome, 'projects', 'tim');
        const sub = path.join(repo, 'packages');
        fs.mkdirSync(sub, { recursive: true });
        (0, marker_js_1.writeMarker)(fakeHome, {
            project: 'P0099',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
        (0, marker_js_1.writeMarker)(repo, {
            project: 'P0063',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
        const found = (0, marker_js_1.findMarker)(sub, { maxRoot: fakeHome });
        (0, vitest_1.expect)(found?.marker.project).toBe('P0063');
        (0, vitest_1.expect)(found?.dir).toBe(fs.realpathSync(repo));
    });
    (0, vitest_1.it)('findMarker returns null when no marker exists up to root (no infinite loop)', () => {
        const sub = path.join(dir, 'x', 'y');
        fs.mkdirSync(sub, { recursive: true });
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })).toBeNull();
    });
    (0, vitest_1.it)('findMarker stops at a corrupt nearest marker (does not silently use an ancestor)', () => {
        (0, marker_js_1.writeMarker)(dir, { project: 'P0002', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const sub = path.join(dir, 'child');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, '.tim-project'), '{ not valid json');
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })).toBeNull();
    });
    // Regression: a hand-edited or stale .tim-project with a malformed
    // project label (e.g. "notalabel", "12345", or wrong digit count)
    // must not be treated as authoritative. The original bug was a P9999
    // label silently binding the session to a non-existent project
    // (TIM's Inbox-fallback is P0000, never P9999). The new whitelist
    // rejects any label that doesn't match the canonical ^[PLEN]\d{4}$
    // shape so the resolution chain falls back to ~/.tim/active-project
    // or INBOX_PROJECT_LABEL (P0000).
    vitest_1.it.each(['notalabel', '12345', 'P12345', 'P', 'P0', 'p0062', 'P006', 'P0062X'])('readMarker returns null for malformed project label %s', (bad) => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: bad,
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
            version: 2,
        }));
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)).toBeNull();
    });
    (0, vitest_1.it)('readMarker returns null for empty project string and wrong-type project', () => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: '',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
            version: 2,
        }));
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)).toBeNull();
    });
    (0, vitest_1.it)('readMarker accepts valid P/L/E/N-prefixed labels', () => {
        for (const label of ['P0062', 'L0042', 'E0031', 'N0014']) {
            fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
                project: label,
                session: 's',
                exchanges: 0,
                batch_size: 5,
                batches_summarized: 0,
                version: 2,
            }));
            (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)?.project).toBe(label);
        }
    });
    (0, vitest_1.it)('findMarker returns null when the only marker has a malformed project label', () => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: 'notalabel',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
            version: 2,
        }));
        const sub = path.join(dir, 'a', 'b');
        fs.mkdirSync(sub, { recursive: true });
        // findMarker must reject the corrupt nearest marker — same
        // contract as for unparseable JSON.
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })).toBeNull();
    });
    (0, vitest_1.it)('buildLoadDirective embeds the label and the load instruction', () => {
        const d = (0, marker_js_1.buildLoadDirective)('P0063', '/home/bbbee/projects/tim');
        (0, vitest_1.expect)(d).toContain('P0063');
        (0, vitest_1.expect)(d).toContain('tim_load_project(label="P0063")');
        (0, vitest_1.expect)(d).toContain('.tim-project');
    });
    (0, vitest_1.it)('buildLoadDirective shows binding label but keeps tool arg as project id', () => {
        const d = (0, marker_js_1.buildLoadDirective)('P0062', '/repo', 'P0062 — bbbee PM Workflow');
        (0, vitest_1.expect)(d).toContain('TIM project P0062 — bbbee PM Workflow');
        (0, vitest_1.expect)(d).toContain('tim_load_project(label="P0062")');
    });
    (0, vitest_1.it)('syncNearestProjectMarker overwrites project on nearest marker', () => {
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0062',
            session: 'bg_old',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
        const sub = path.join(dir, 'repo');
        fs.mkdirSync(sub, { recursive: true });
        (0, marker_js_1.writeMarker)(sub, {
            project: 'P0062',
            session: 'bg_old',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
        (0, vitest_1.expect)((0, marker_js_1.syncNearestProjectMarker)(sub, 'P0063', {
            sessionId: '20260602_155620_ee0929',
            findOptions: { maxRoot: dir },
        })).toBe(true);
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(sub)?.project).toBe('P0063');
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(sub)?.session).toBe('20260602_155620_ee0929');
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)?.project).toBe('P0062');
    });
});
(0, vitest_1.describe)('marker v2 schema', () => {
    let dir;
    (0, vitest_1.beforeEach)(() => {
        fs.mkdirSync(TEST_ROOT, { recursive: true });
        dir = fs.mkdtempSync(path.join(TEST_ROOT, 'marker-v2-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('writeMarker stamps the current version on disk', () => {
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0001',
            session: 's1',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
        (0, vitest_1.expect)(onDisk.version).toBe(2);
    });
    (0, vitest_1.it)('readMarker returns the v2 shape (with version: 2)', () => {
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0001',
            session: 's1',
            exchanges: 3,
            batch_size: 5,
            batches_summarized: 1,
        });
        const m = (0, marker_js_1.readMarker)(dir);
        (0, vitest_1.expect)(m?.version).toBe(2);
        (0, vitest_1.expect)(m?.project).toBe('P0001');
        (0, vitest_1.expect)(m?.session).toBe('s1');
        (0, vitest_1.expect)(m?.exchanges).toBe(3);
        (0, vitest_1.expect)(m?.batch_size).toBe(5);
        (0, vitest_1.expect)(m?.batches_summarized).toBe(1);
    });
    (0, vitest_1.it)('readMarker auto-upgrades a v1 file (no version field) to v2 in memory', () => {
        // Hand-write a v1 file on disk — no `version` field, plus legacy cruft.
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: 'P0062',
            session: 'bg',
            exchanges: 42,
            batch_size: 5,
            batches_summarized: 2,
            route_exchanges_to: 'P0063',
            sessions: { P0063: '20260602_155620_ee0929' },
        }, null, 2));
        const m = (0, marker_js_1.readMarker)(dir);
        (0, vitest_1.expect)(m).toEqual({
            version: 2,
            project: 'P0062',
            session: 'bg',
            exchanges: 42,
            batch_size: 5,
            batches_summarized: 2,
        });
    });
    (0, vitest_1.it)('readMarker does NOT rewrite the v1 file on read (auto-upgrade happens on next write)', () => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: 'P0062',
            session: 'bg',
            exchanges: 42,
            batch_size: 5,
            batches_summarized: 2,
            route_exchanges_to: 'P0063',
        }, null, 2));
        (0, marker_js_1.readMarker)(dir); // should not touch the file
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
        (0, vitest_1.expect)(onDisk.version).toBeUndefined();
        (0, vitest_1.expect)(onDisk.route_exchanges_to).toBe('P0063');
    });
    (0, vitest_1.it)('the first write to a v1 file upgrades it to v2 on disk', () => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: 'P0062',
            session: 'bg',
            exchanges: 42,
            batch_size: 5,
            batches_summarized: 2,
            route_exchanges_to: 'P0063',
            sessions: { P0063: 'old' },
        }, null, 2));
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0062',
            session: 'bg',
            exchanges: 50,
            batch_size: 5,
            batches_summarized: 2,
        });
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.tim-project'), 'utf8'));
        (0, vitest_1.expect)(onDisk.version).toBe(2);
        (0, vitest_1.expect)(onDisk.exchanges).toBe(50);
        (0, vitest_1.expect)(onDisk.route_exchanges_to).toBeUndefined();
        (0, vitest_1.expect)(onDisk.sessions).toBeUndefined();
    });
    (0, vitest_1.it)('readMarker strips legacy fields even if version is 1 (corrupt-ish v1)', () => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            version: 1,
            project: 'P0001',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
            route_exchanges_to: 'X',
            sessions: { X: 'y' },
        }, null, 2));
        const m = (0, marker_js_1.readMarker)(dir);
        (0, vitest_1.expect)(m?.version).toBe(2);
        (0, vitest_1.expect)(m).not.toHaveProperty('route_exchanges_to');
        (0, vitest_1.expect)(m).not.toHaveProperty('sessions');
    });
    (0, vitest_1.it)('readMarker returns null for a marker missing required numeric fields', () => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: 'P0001',
            session: 's',
            // exchanges missing
            batch_size: 5,
            batches_summarized: 0,
        }, null, 2));
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)).toBeNull();
    });
    (0, vitest_1.it)('readMarker returns null for a marker with non-numeric counters', () => {
        fs.writeFileSync(path.join(dir, '.tim-project'), JSON.stringify({
            project: 'P0001',
            session: 's',
            exchanges: 'not a number',
            batch_size: 5,
            batches_summarized: 0,
        }, null, 2));
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)).toBeNull();
    });
    (0, vitest_1.it)('ProjectMarkerInput accepts a marker without version (writer fills it in)', () => {
        // Type-level test: this line must compile.
        const input = {
            project: 'P0001',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        };
        (0, marker_js_1.writeMarker)(dir, input);
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)?.version).toBe(2);
    });
});
// ─── DB-existence validation (P9999 defense-in-depth) ────────────────────
//
// The pattern check in normalizeMarker catches "P9", "P", "notalabel",
// etc. — but a label like "P9999" matches the pattern yet never
// corresponds to a real TIM project. The P9999 bug bound the statusline
// to a non-existent project because the on-disk marker was trusted.
// `validateMarkerAgainstStore` closes that gap: the marker is only
// accepted when the project label resolves to a real entry in the DB.
(0, vitest_1.describe)('validateMarkerAgainstStore', () => {
    let store;
    (0, vitest_1.beforeEach)(() => {
        store = new tim_store_1.TimStore(':memory:');
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
    });
    (0, vitest_1.it)('rejects a pattern-valid label that has no matching DB entry (P9999 case)', async () => {
        await store.createProject('P0062');
        const bogus = {
            version: 2,
            project: 'P9999',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        };
        (0, vitest_1.expect)(await (0, marker_js_1.validateMarkerAgainstStore)(bogus, store)).toBeNull();
    });
    (0, vitest_1.it)('accepts a label that resolves to a real project, returning the canonical form', async () => {
        await store.createProject('P0062');
        const ok = {
            version: 2,
            project: 'P0062',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        };
        const validated = await (0, marker_js_1.validateMarkerAgainstStore)(ok, store);
        (0, vitest_1.expect)(validated?.project).toBe('P0062');
    });
    (0, vitest_1.it)('accepts the Inbox (P0000) even when it is not yet materialized in the DB', async () => {
        // P0000 is exempt: tim-store.ensureInboxProject() creates it lazily,
        // and session-start should never block on that materialization just
        // to validate a marker.
        const inbox = {
            version: 2,
            project: marker_js_1.INBOX_LABEL,
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        };
        const validated = await (0, marker_js_1.validateMarkerAgainstStore)(inbox, store);
        (0, vitest_1.expect)(validated?.project).toBe('P0000');
    });
    (0, vitest_1.it)('fails open (accepts) when the DB lookup itself throws — pattern check still gates', async () => {
        const ok = {
            version: 2,
            project: 'P0062',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        };
        const broken = {
            resolveProjectLabel: () => {
                throw new Error('db locked');
            },
        };
        // The marker is returned unchanged — we never reject a label that
        // already passed the pattern check just because the DB is briefly
        // unavailable. The pattern check is the strict gate; the DB
        // existence check is the soft gate.
        (0, vitest_1.expect)(await (0, marker_js_1.validateMarkerAgainstStore)(ok, broken)).toEqual(ok);
    });
});
//# sourceMappingURL=marker.test.js.map