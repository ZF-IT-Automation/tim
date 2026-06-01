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
const TEST_ROOT = path.join('/home/bbbee', '.tim-test-runs');
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
});
//# sourceMappingURL=marker.test.js.map