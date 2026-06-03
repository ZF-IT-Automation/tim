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
            project: 'P1',
            session: 's1',
            exchanges: 3,
            batch_size: 5,
            batches_summarized: 0,
        });
        (0, vitest_1.expect)((0, marker_js_1.readMarker)(dir)).toMatchObject({ project: 'P1', session: 's1', exchanges: 3 });
    });
    (0, vitest_1.it)('detectProject prefers the .tim-project marker', () => {
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P9',
            session: 's',
            exchanges: 0,
            batch_size: 5,
            batches_summarized: 0,
        });
        (0, vitest_1.expect)((0, marker_js_1.detectProject)(dir)?.project).toBe('P9');
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
        (0, marker_js_1.writeMarker)(dir, { project: 'P1', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const found = (0, marker_js_1.findMarker)(dir, { maxRoot: dir });
        (0, vitest_1.expect)(found?.marker.project).toBe('P1');
        (0, vitest_1.expect)(found?.dir).toBe(fs.realpathSync(dir));
    });
    (0, vitest_1.it)('findMarker walks up to a parent marker', () => {
        (0, marker_js_1.writeMarker)(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const sub = path.join(dir, 'a', 'b', 'c');
        fs.mkdirSync(sub, { recursive: true });
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })?.marker.project).toBe('PARENT');
    });
    (0, vitest_1.it)('findMarker: nearest marker wins over an ancestor', () => {
        (0, marker_js_1.writeMarker)(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const sub = path.join(dir, 'child');
        fs.mkdirSync(sub, { recursive: true });
        (0, marker_js_1.writeMarker)(sub, { project: 'CHILD', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })?.marker.project).toBe('CHILD');
    });
    (0, vitest_1.it)('findMarker returns null when no marker exists up to root (no infinite loop)', () => {
        const sub = path.join(dir, 'x', 'y');
        fs.mkdirSync(sub, { recursive: true });
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })).toBeNull();
    });
    (0, vitest_1.it)('findMarker stops at a corrupt nearest marker (does not silently use an ancestor)', () => {
        (0, marker_js_1.writeMarker)(dir, { project: 'PARENT', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
        const sub = path.join(dir, 'child');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, '.tim-project'), '{ not valid json');
        (0, vitest_1.expect)((0, marker_js_1.findMarker)(sub, { maxRoot: dir })).toBeNull();
    });
    (0, vitest_1.it)('buildLoadDirective embeds the label and the load instruction', () => {
        const d = (0, marker_js_1.buildLoadDirective)('P0063', '/home/bbbee/projects/tim');
        (0, vitest_1.expect)(d).toContain('P0063');
        (0, vitest_1.expect)(d).toContain('tim_load_project(label="P0063")');
        (0, vitest_1.expect)(d).toContain('.tim-project');
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
//# sourceMappingURL=marker.test.js.map