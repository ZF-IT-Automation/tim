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
exports.getSyncConfigPath = getSyncConfigPath;
exports.getSyncStatePath = getSyncStatePath;
exports.getDeviceIdPath = getDeviceIdPath;
exports.getQueuePath = getQueuePath;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.clearConfig = clearConfig;
exports.clearSyncState = clearSyncState;
exports.clearSyncConnection = clearSyncConnection;
exports.loadSyncState = loadSyncState;
exports.saveSyncState = saveSyncState;
exports.getDeviceId = getDeviceId;
exports.defaultFileId = defaultFileId;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const tim_core_1 = require("tim-core");
function getSyncConfigPath() {
    return path.join((0, tim_core_1.getTimDir)(), 'sync.json');
}
function getSyncStatePath() {
    return path.join((0, tim_core_1.getTimDir)(), 'sync-state.json');
}
function getDeviceIdPath() {
    return path.join((0, tim_core_1.getTimDir)(), 'device-id');
}
function getQueuePath(fileId) {
    return path.join((0, tim_core_1.getTimDir)(), `${fileId}.queue.json`);
}
function loadConfig() {
    const p = getSyncConfigPath();
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
function saveConfig(config) {
    const dir = (0, tim_core_1.getTimDir)();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getSyncConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
function clearConfig() {
    const p = getSyncConfigPath();
    if (!fs.existsSync(p))
        return false;
    fs.unlinkSync(p);
    return true;
}
function clearSyncState() {
    const p = getSyncStatePath();
    if (!fs.existsSync(p))
        return false;
    fs.unlinkSync(p);
    return true;
}
function clearSyncConnection() {
    return {
        config: clearConfig(),
        state: clearSyncState(),
    };
}
function loadSyncState() {
    const p = getSyncStatePath();
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
function saveSyncState(state) {
    const dir = (0, tim_core_1.getTimDir)();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getSyncStatePath(), JSON.stringify(state, null, 2));
}
function getDeviceId() {
    const p = getDeviceIdPath();
    if (fs.existsSync(p)) {
        const id = fs.readFileSync(p, 'utf8').trim();
        if (id)
            return id;
    }
    const dir = (0, tim_core_1.getTimDir)();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const id = (0, node_crypto_1.randomUUID)();
    fs.writeFileSync(p, id, { mode: 0o600 });
    return id;
}
function defaultFileId(deviceId) {
    return `tim-${deviceId ?? getDeviceId()}`;
}
//# sourceMappingURL=config.js.map