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
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
const index_js_1 = require("../index.js");
(0, vitest_1.describe)('config hooks parsing', () => {
    (0, vitest_1.it)('handles absent hooks (backward compatible)', () => {
        const config = (0, tim_core_1.loadConfig)();
        (0, vitest_1.expect)(config.hooks?.enabled).not.toBe(false);
        (0, vitest_1.expect)((0, tim_core_1.normalizeHookScripts)(undefined)).toEqual([]);
    });
    (0, vitest_1.it)('normalizes string vs array scripts', () => {
        (0, vitest_1.expect)((0, tim_core_1.normalizeHookScripts)('echo hi')).toEqual(['echo hi']);
        (0, vitest_1.expect)((0, tim_core_1.normalizeHookScripts)(['a', 'b'])).toEqual(['a', 'b']);
    });
});
(0, vitest_1.describe)('hook runner', () => {
    (0, vitest_1.it)('injects env vars', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-hook-'));
        const outFile = path.join(tmpDir, 'out.txt');
        const script = `echo "$TIM_SESSION_ID|$TIM_AGENT|$TIM_CWD" > "${outFile}"`;
        await (0, index_js_1.runHookScript)(script, {
            env: {
                TIM_SESSION_ID: 'sess-env',
                TIM_AGENT: 'test-agent',
                TIM_CWD: tmpDir,
            },
            cwd: tmpDir,
            timeoutMs: 5000,
        });
        const content = fs.readFileSync(outFile, 'utf8').trim();
        (0, vitest_1.expect)(content).toBe(`sess-env|test-agent|${tmpDir}`);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('enforces timeout', async () => {
        const result = await (0, index_js_1.runHookScript)('sleep 5', { timeoutMs: 100 });
        (0, vitest_1.expect)(result.timedOut).toBe(true);
    });
    (0, vitest_1.it)('treats non-zero exit as non-fatal', async () => {
        const errSpy = vitest_1.vi.spyOn(console, 'error').mockImplementation(() => { });
        const results = await (0, index_js_1.runHooks)({ scripts: 'exit 42', timeoutMs: 5000 });
        (0, vitest_1.expect)(results[0].exitCode).toBe(42);
        (0, vitest_1.expect)(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });
});
(0, vitest_1.describe)('session-end checkpoint orchestration', () => {
    (0, vitest_1.it)('runs sessionEnd hooks then checkpoint', async () => {
        const store = new tim_store_1.TimStore(':memory:');
        const sessions = new tim_store_1.SessionManager(store);
        await sessions.sessionStart({
            sessionId: 'end-test',
            agentName: 'agent',
            cwd: '/',
            harness: 'test',
        });
        await sessions.sessionLog('end-test', [
            { role: 'user', content: 'done' },
        ]);
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-end-'));
        const marker = path.join(tmpDir, 'ran.txt');
        const script = `touch "${marker}"`;
        const summary = await (0, index_js_1.runSessionEnd)(store, 'end-test', {
            hooksConfig: {
                sessionEnd: script,
                enabled: true,
                timeoutMs: 5000,
            },
            env: { TIM_CWD: tmpDir },
        });
        (0, vitest_1.expect)(fs.existsSync(marker)).toBe(true);
        (0, vitest_1.expect)(summary.metadata.kind).toBe('checkpoint');
        fs.rmSync(tmpDir, { recursive: true, force: true });
        store.close();
    });
    (0, vitest_1.it)('session-start runs configured hook', async () => {
        const store = new tim_store_1.TimStore(':memory:');
        fs.mkdirSync('/home/bbbee/.tim-test-runs', { recursive: true });
        const tmpDir = fs.mkdtempSync(path.join('/home/bbbee/.tim-test-runs', 'tim-start-'));
        const marker = path.join(tmpDir, 'started.txt');
        const script = `touch "${marker}"`;
        await (0, index_js_1.runSessionStart)(store, {
            sessionId: 'start-test',
            agentName: 'agent',
            cwd: tmpDir,
            harness: 'test',
            hooksConfig: {
                sessionStart: script,
                enabled: true,
                timeoutMs: 5000,
            },
        });
        (0, vitest_1.expect)(fs.existsSync(marker)).toBe(true);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        store.close();
    });
    (0, vitest_1.it)('loads project context when active-project file is set', async () => {
        const store = new tim_store_1.TimStore(':memory:');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-proj-'));
        const originalHome = process.env.HOME;
        try {
            process.env.HOME = tmp;
            fs.mkdirSync(path.join(tmp, '.tim'), { recursive: true });
            fs.writeFileSync(path.join(tmp, '.tim', 'active-project'), 'P0099');
            await store.write('Project body', {
                metadata: { kind: 'project', label: 'P0099' },
                tags: ['#project'],
            });
            const result = await (0, index_js_1.runSessionStart)(store, {
                sessionId: 'proj-test',
                agentName: 'agent',
                cwd: '/tmp',
                harness: 'test',
            });
            (0, vitest_1.expect)(result.session.metadata.kind).toBe('session');
            (0, vitest_1.expect)(result.project?.metadata.label).toBe('P0099');
        }
        finally {
            process.env.HOME = originalHome;
            fs.rmSync(tmp, { recursive: true, force: true });
            store.close();
        }
    });
    (0, vitest_1.it)('runSessionStart resolves a parent .tim-project from a subdirectory', async () => {
        const store = new tim_store_1.TimStore(':memory:');
        await store.createProject('P0042');
        const root = fs.mkdtempSync(path.join('/home/bbbee', '.tim-test-runs', 'sess-'));
        fs.writeFileSync(path.join(root, '.tim-project'), JSON.stringify({ project: 'P0042', session: 'old', exchanges: 0, batch_size: 5, batches_summarized: 0 }));
        const sub = path.join(root, 'pkg', 'inner');
        fs.mkdirSync(sub, { recursive: true });
        const { project } = await (0, index_js_1.runSessionStart)(store, {
            sessionId: 'sess-sub',
            agentName: 'a',
            cwd: sub,
            harness: 'test',
        });
        (0, vitest_1.expect)(project?.metadata.label ?? project?.id).toBe('P0042');
        store.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
});
(0, vitest_1.describe)('saveConfig roundtrip', () => {
    (0, vitest_1.it)('persists hooks config', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-cfg-'));
        const configPath = path.join(tmp, '.tim', 'config.json');
        const originalHome = process.env.HOME;
        try {
            process.env.HOME = tmp;
            const config = {
                dbPath: path.join(tmp, 'tim.db'),
                deviceId: 'dev-1',
                hooks: {
                    sessionStart: 'echo start',
                    sessionEnd: ['echo end1', 'echo end2'],
                    enabled: true,
                    timeoutMs: 1234,
                },
            };
            (0, tim_core_1.saveConfig)(config);
            const loaded = (0, tim_core_1.loadConfig)();
            (0, vitest_1.expect)(loaded.hooks?.sessionStart).toBe('echo start');
            (0, vitest_1.expect)(loaded.hooks?.sessionEnd).toEqual(['echo end1', 'echo end2']);
            (0, vitest_1.expect)(loaded.hooks?.timeoutMs).toBe(1234);
            (0, vitest_1.expect)(fs.existsSync(configPath)).toBe(true);
        }
        finally {
            process.env.HOME = originalHome;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=hooks.test.js.map