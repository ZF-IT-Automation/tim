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
const os = __importStar(require("os"));
const store_js_1 = require("../store.js");
const project_display_js_1 = require("../project-display.js");
(0, vitest_1.describe)('project-display', () => {
    let dbPath;
    let store;
    (0, vitest_1.afterEach)(() => {
        store?.close();
        if (dbPath && fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    (0, vitest_1.it)('cropDisplayName limits to maxLen including ellipsis', () => {
        (0, vitest_1.expect)((0, project_display_js_1.cropDisplayName)('short')).toBe('short');
        (0, vitest_1.expect)((0, project_display_js_1.cropDisplayName)('abcdefghijklmnopqrst', 20)).toBe('abcdefghijklmnopqrst');
        (0, vitest_1.expect)((0, project_display_js_1.cropDisplayName)('abcdefghijklmnopqrstu', 20)).toBe('abcdefghijklmnopqrs…');
    });
    (0, vitest_1.it)('projectDisplayNameFromEntry strips label prefix from title', async () => {
        dbPath = path.join(os.tmpdir(), `tim-pd-${Date.now()}.db`);
        store = new store_js_1.TimStore(dbPath);
        const entry = await store.createProject('P0062', {
            content: 'P0062 — TIM | Active | memory system\nbody',
        });
        (0, vitest_1.expect)((0, project_display_js_1.projectDisplayNameFromEntry)(entry)).toBe('TIM');
    });
    (0, vitest_1.it)('resolveProjectDisplayName resolves alias and crops', async () => {
        dbPath = path.join(os.tmpdir(), `tim-pd2-${Date.now()}.db`);
        store = new store_js_1.TimStore(dbPath);
        await store.createProject('P0048', {
            content: 'Its Over 9000 Memory | Active\nx',
            aliases: ['o9k'],
        });
        (0, vitest_1.expect)(await (0, project_display_js_1.resolveProjectDisplayName)(store, 'o9k')).toBe('Its Over 9000 Memory');
        (0, vitest_1.expect)(await (0, project_display_js_1.resolveProjectDisplayName)(store, 'P0048', 10)).toBe('Its Over …');
    });
    (0, vitest_1.it)('resolveProjectBindingLabel returns label — title uncropped', async () => {
        dbPath = path.join(os.tmpdir(), `tim-pd3-${Date.now()}.db`);
        store = new store_js_1.TimStore(dbPath);
        await store.createProject('P0062', {
            content: 'bbbee PM Workflow | Active\nx',
        });
        (0, vitest_1.expect)(await (0, project_display_js_1.resolveProjectBindingLabel)(store, 'P0062')).toBe('P0062 — bbbee PM Workflow');
    });
});
//# sourceMappingURL=project-display.test.js.map