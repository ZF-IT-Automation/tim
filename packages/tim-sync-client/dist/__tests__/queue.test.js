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
const queue_js_1 = require("../queue.js");
(0, vitest_1.describe)('queue', () => {
    let queuePath;
    (0, vitest_1.beforeEach)(() => {
        queuePath = path.join(os.tmpdir(), `tim-queue-${Date.now()}.json`);
    });
    (0, vitest_1.afterEach)(() => {
        if (fs.existsSync(queuePath))
            fs.unlinkSync(queuePath);
        if (fs.existsSync(`${queuePath}.tmp`))
            fs.unlinkSync(`${queuePath}.tmp`);
    });
    (0, vitest_1.it)('chunks large pushes at 500', () => {
        const envelopes = [];
        const blobs = [];
        for (let i = 0; i < queue_js_1.PUSH_CHUNK + 10; i++) {
            envelopes.push({
                v: 1, type: 'entry', key: `k${i}`, lww: new Date().toISOString(),
                deleted: false, payload: '{}',
            });
            blobs.push({
                proposed_id: `k${i}`,
                data: 'enc',
                device_id: 'dev',
                updated_at: new Date().toISOString(),
            });
        }
        const q = (0, queue_js_1.loadQueue)(queuePath);
        (0, queue_js_1.enqueue)(queuePath, q, envelopes, blobs);
        const loaded = (0, queue_js_1.loadQueue)(queuePath);
        (0, vitest_1.expect)(loaded.length).toBe(2);
        (0, vitest_1.expect)(loaded[0].blobs.length).toBe(queue_js_1.PUSH_CHUNK);
        (0, vitest_1.expect)(loaded[1].blobs.length).toBe(10);
    });
    (0, vitest_1.it)('flushQueue drains on success', async () => {
        const q = (0, queue_js_1.loadQueue)(queuePath);
        const env = {
            v: 1, type: 'entry', key: 'a', lww: new Date().toISOString(),
            deleted: false, payload: '{}',
        };
        (0, queue_js_1.enqueue)(queuePath, q, [env], [{
                proposed_id: 'a', data: 'x', device_id: 'd', updated_at: env.lww,
            }]);
        const loaded = (0, queue_js_1.loadQueue)(queuePath);
        const sent = [];
        const result = await (0, queue_js_1.flushQueue)(queuePath, loaded, async (item) => {
            sent.push(item.idempotency_key);
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        (0, vitest_1.expect)(sent.length).toBe(1);
        (0, vitest_1.expect)((0, queue_js_1.loadQueue)(queuePath).length).toBe(0);
    });
});
//# sourceMappingURL=queue.test.js.map