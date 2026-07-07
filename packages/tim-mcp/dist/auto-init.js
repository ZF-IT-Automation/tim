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
exports.runAutoInit = runAutoInit;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
/**
 * Zero-config bootstrap: create DB + default config on first connect.
 * Never throws — server must start even when init fails.
 */
async function runAutoInit(options) {
    const result = {
        ok: true,
        dbCreated: false,
        configCreated: false,
    };
    const config = (0, tim_core_1.loadConfig)();
    const dbPath = options?.dbPath ?? config.dbPath;
    if (!dbPath) {
        result.ok = false;
        result.error = 'no dbPath configured';
        return result;
    }
    try {
        const dbExisted = fs.existsSync(dbPath);
        if (!dbExisted) {
            const dir = path.dirname(dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        const store = new tim_store_1.TimStore(dbPath);
        if (!dbExisted) {
            result.dbCreated = true;
        }
        const agents = await store.getAgents();
        if (!agents.some(a => a.label === 'default')) {
            try {
                await store.registerAgent('Default Agent', 'default');
            }
            catch {
                // Race: another connect may have registered concurrently.
            }
        }
        store.close();
        const configPath = (0, tim_core_1.getConfigPath)();
        if (!fs.existsSync(configPath)) {
            const timDir = (0, tim_core_1.getTimDir)();
            if (!fs.existsSync(timDir)) {
                fs.mkdirSync(timDir, { recursive: true });
            }
            (0, tim_core_1.saveConfig)((0, tim_core_1.loadConfig)());
            result.configCreated = true;
        }
    }
    catch (err) {
        result.ok = false;
        result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
}
//# sourceMappingURL=auto-init.js.map