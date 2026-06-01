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
const store_js_1 = require("../store.js");
const sync_methods_js_1 = require("../sync-methods.js");
(0, vitest_1.describe)('sync-methods', () => {
    let dbPath;
    let store;
    (0, vitest_1.beforeEach)(() => {
        dbPath = path.join(os.tmpdir(), `tim-sync-methods-${Date.now()}.db`);
        store = new store_js_1.TimStore(dbPath);
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    (0, vitest_1.it)('acks staging keys', async () => {
        await store.write('hello');
        const db = store.getDb();
        (0, vitest_1.expect)((0, sync_methods_js_1.getUnackedStaging)(db).length).toBe(1);
        (0, sync_methods_js_1.ackStaging)(db, [(0, sync_methods_js_1.getUnackedStaging)(db)[0].key]);
        (0, vitest_1.expect)((0, sync_methods_js_1.getUnackedStaging)(db).length).toBe(0);
    });
    (0, vitest_1.it)('applyRemoteEntry upserts when newer', async () => {
        await store.write('local', { id: 'REMOTE01' });
        const db = store.getDb();
        const payload = JSON.stringify({
            id: 'REMOTE01',
            parent_id: null,
            content: 'remote wins',
            content_type: 'text',
            depth: 1,
            confidence: 1,
            created_at: new Date().toISOString(),
            accessed_at: new Date().toISOString(),
            decay_rate: 0,
            visibility: 1,
            tags: '[]',
            irrelevant: 0,
            favorite: 0,
            tombstoned_at: null,
            metadata: '{}',
        });
        const applied = (0, sync_methods_js_1.applyRemoteEntry)(db, payload, Date.now() + 10_000, 'remote', false);
        (0, vitest_1.expect)(applied).toBe(true);
        const entry = await store.read('REMOTE01');
        (0, vitest_1.expect)(entry?.content).toBe('remote wins');
    });
});
//# sourceMappingURL=sync-methods.test.js.map