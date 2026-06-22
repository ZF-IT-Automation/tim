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
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const index_js_1 = require("../index.js");
(0, vitest_1.describe)('concurrent TimStore', () => {
    let dbPath;
    (0, vitest_1.beforeEach)(() => {
        dbPath = path.join(os.tmpdir(), `tim-concurrent-${crypto.randomBytes(8).toString('hex')}.db`);
    });
    (0, vitest_1.afterEach)(() => {
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                fs.rmSync(dbPath + suffix, { force: true });
            }
            catch {
                // ignore cleanup races
            }
        }
    });
    (0, vitest_1.it)('busy_timeout allows concurrent writers to wait', async () => {
        const store1 = new index_js_1.TimStore(dbPath);
        const store2 = new index_js_1.TimStore(dbPath);
        try {
            const [entry1, entry2] = await Promise.all([
                store1.createProject('P1001', { content: 'Project A' }),
                store2.createProject('P1002', { content: 'Project B' }),
            ]);
            (0, vitest_1.expect)(entry1.metadata.label).toBe('P1001');
            (0, vitest_1.expect)(entry2.metadata.label).toBe('P1002');
        }
        finally {
            store1.close();
            store2.close();
        }
    });
    (0, vitest_1.it)('concurrent createProject with same label — exactly one succeeds', async () => {
        const store1 = new index_js_1.TimStore(dbPath);
        const store2 = new index_js_1.TimStore(dbPath);
        try {
            const [result1, result2] = await Promise.all([
                store1.createProject('P9999').then((entry) => ({ ok: true, entry }), (error) => ({ ok: false, error })),
                store2.createProject('P9999').then((entry) => ({ ok: true, entry }), (error) => ({ ok: false, error })),
            ]);
            (0, vitest_1.expect)(result1.ok !== result2.ok).toBe(true);
            const success = result1.ok ? result1 : result2;
            const failure = result1.ok ? result2 : result1;
            (0, vitest_1.expect)(success.ok).toBe(true);
            if (success.ok) {
                (0, vitest_1.expect)(success.entry.metadata.label).toBe('P9999');
            }
            (0, vitest_1.expect)(failure.ok).toBe(false);
            if (!failure.ok) {
                (0, vitest_1.expect)(failure.error).toBeInstanceOf(Error);
                (0, vitest_1.expect)(String(failure.error)).toMatch(/Project label already exists|SQLITE_CONSTRAINT|UNIQUE/i);
            }
        }
        finally {
            store1.close();
            store2.close();
        }
    });
});
//# sourceMappingURL=concurrent-store.test.js.map