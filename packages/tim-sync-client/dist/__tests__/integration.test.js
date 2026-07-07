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
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const tim_store_1 = require("tim-store");
const tim_store_2 = require("tim-store");
const index_js_1 = require("../index.js");
// Isolate ~/.tim (sync-state.json, queues) from the real home and from other
// test files — vitest runs each file in its own process, so the override is safe.
const origHome = process.env.HOME;
let tmpHome;
(0, vitest_1.beforeAll)(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-int-home-'));
    process.env.HOME = tmpHome;
});
(0, vitest_1.afterAll)(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
});
(0, vitest_1.describe)('sync integration', () => {
    let server;
    let dbPath;
    const deviceId = 'test-device-001';
    const fileId = `tim-${deviceId}`;
    const passphrase = 'integration-test';
    const salt = (0, index_js_1.generateSalt)();
    const port = 3199;
    (0, vitest_1.beforeAll)(async () => {
        (0, index_js_1.resetDevServer)();
        // Clear stale sync state from previous runs (causes pull to skip blobs)
        try {
            fs.unlinkSync(path.join(os.homedir(), '.tim', 'sync-state.json'));
        }
        catch { }
        server = (0, index_js_1.startDevServer)(port);
        await new Promise((r) => server.once('listening', r));
        const client = new index_js_1.TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
        await client.createFile(fileId, salt);
        dbPath = path.join(os.tmpdir(), `tim-sync-int-${Date.now()}.db`);
    });
    (0, vitest_1.afterAll)(() => {
        server.close();
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    (0, vitest_1.it)('push then pull restores entry on fresh DB', async () => {
        const store1 = new tim_store_1.TimStore(dbPath);
        await store1.write('sync test entry', { confidence: 0.8 });
        (0, vitest_1.expect)((0, tim_store_2.getUnackedStaging)(store1.getDb()).length).toBeGreaterThan(0);
        const ctx1 = (0, index_js_1.buildSyncContext)(store1, {
            serverUrl: `http://127.0.0.1:${port}`,
            token: 'test-token',
            salt,
            fileId,
        }, passphrase, deviceId);
        const { pushed } = await (0, index_js_1.runPush)(ctx1);
        (0, vitest_1.expect)(pushed).toBeGreaterThan(0);
        store1.close();
        const dbPath2 = `${dbPath}.remote`;
        if (fs.existsSync(dbPath2))
            fs.unlinkSync(dbPath2);
        const store2 = new tim_store_1.TimStore(dbPath2);
        const ctx2 = (0, index_js_1.buildSyncContext)(store2, {
            serverUrl: `http://127.0.0.1:${port}`,
            token: 'test-token',
            salt,
            fileId,
        }, passphrase, deviceId);
        const { pulled } = await (0, index_js_1.runPull)(ctx2);
        (0, vitest_1.expect)(pulled).toBeGreaterThan(0);
        const stats = await store2.stats();
        (0, vitest_1.expect)(stats.totalEntries).toBeGreaterThan(0);
        store2.close();
        fs.unlinkSync(dbPath2);
    });
});
//# sourceMappingURL=integration.test.js.map