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
const session_hooks_js_1 = require("../session-hooks.js");
const marker_js_1 = require("../marker.js");
const tim_store_1 = require("tim-store");
const TEST_ROOT = path.join('/home/bbbee', '.tim-test-runs');
(0, vitest_1.describe)('onSessionStop', () => {
    let dir;
    let store;
    let sessions;
    (0, vitest_1.beforeEach)(async () => {
        fs.mkdirSync(TEST_ROOT, { recursive: true });
        dir = fs.mkdtempSync(path.join(TEST_ROOT, 'stop-'));
        store = new tim_store_1.TimStore(':memory:');
        sessions = new tim_store_1.SessionManager(store);
        await store.createProject('P0003');
        await sessions.startProjectSession({
            sessionId: 'st',
            projectId: 'P0003',
            agentName: 'a',
            cwd: dir,
            harness: 't',
            batchSize: 2,
        });
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('spawns the summarizer when pending >= batch_size', async () => {
        await sessions.logExchange('st', [
            { role: 'user', content: 'q1' },
            { role: 'agent', content: 'a1' },
            { role: 'user', content: 'q2' },
            { role: 'agent', content: 'a2' },
        ]);
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0003',
            session: 'st',
            exchanges: 0,
            batch_size: 2,
            batches_summarized: 0,
        });
        const spawn = vitest_1.vi.fn();
        const res = await (0, session_hooks_js_1.onSessionStop)(store, dir, { spawn });
        (0, vitest_1.expect)(res.spawned).toBe(true);
        (0, vitest_1.expect)(spawn).toHaveBeenCalledOnce();
        const [cmd, ctx] = spawn.mock.calls[0];
        (0, vitest_1.expect)(cmd).toContain('trap');
        (0, vitest_1.expect)(cmd).toContain('timeout');
        (0, vitest_1.expect)(cmd).toContain('.tim/summarizer.log');
        (0, vitest_1.expect)(ctx.sessionId).toBe('st');
    });
    (0, vitest_1.it)('buildSummarizerCommand uses EXIT trap and tim-summarizer path', () => {
        const cmd = (0, session_hooks_js_1.buildSummarizerCommand)('sid', '/tmp/lock', '/tmp/log', 120);
        (0, vitest_1.expect)(cmd).toContain('trap');
        (0, vitest_1.expect)(cmd).toContain('EXIT');
        (0, vitest_1.expect)(cmd).toContain('tim-summarizer');
        (0, vitest_1.expect)(cmd).toContain('timeout 120');
        (0, vitest_1.expect)(cmd).toContain('TIM_SESSION_ID');
    });
    (0, vitest_1.it)('maybeSpawnSummarizer with batchFull skips below-threshold', async () => {
        await sessions.logExchange('st', [{ role: 'user', content: 'only' }]);
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0003',
            session: 'st',
            exchanges: 1,
            batch_size: 2,
            batches_summarized: 0,
        });
        const spawn = vitest_1.vi.fn();
        const res = await (0, session_hooks_js_1.maybeSpawnSummarizer)(store, dir, { spawn, batchFull: true });
        (0, vitest_1.expect)(res.spawned).toBe(true);
        (0, vitest_1.expect)(spawn).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)('does NOT spawn when pending < batch_size', async () => {
        await sessions.logExchange('st', [{ role: 'user', content: 'only one' }]);
        (0, marker_js_1.writeMarker)(dir, {
            project: 'P0003',
            session: 'st',
            exchanges: 0,
            batch_size: 2,
            batches_summarized: 0,
        });
        const spawn = vitest_1.vi.fn();
        const res = await (0, session_hooks_js_1.onSessionStop)(store, dir, { spawn });
        (0, vitest_1.expect)(res.spawned).toBe(false);
        (0, vitest_1.expect)(spawn).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('skips silently when no marker is present', async () => {
        const spawn = vitest_1.vi.fn();
        const res = await (0, session_hooks_js_1.onSessionStop)(store, dir, { spawn });
        (0, vitest_1.expect)(res.spawned).toBe(false);
        (0, vitest_1.expect)(res.reason).toBe('no-marker');
    });
});
//# sourceMappingURL=session-hooks.test.js.map