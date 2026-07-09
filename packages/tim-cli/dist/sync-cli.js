"use strict";
// TIM sync CLI commands
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
exports.cmdSyncConnect = cmdSyncConnect;
exports.cmdSyncPush = cmdSyncPush;
exports.cmdSyncPull = cmdSyncPull;
exports.cmdSyncStatus = cmdSyncStatus;
exports.cmdSyncDisconnect = cmdSyncDisconnect;
exports.cmdSyncDev = cmdSyncDev;
exports.cmdSync = cmdSync;
const fs = __importStar(require("node:fs"));
const readline = __importStar(require("node:readline/promises"));
const node_process_1 = require("node:process");
const tim_store_1 = require("tim-store");
const tim_store_2 = require("tim-store");
const tim_sync_client_1 = require("tim-sync-client");
const tim_core_1 = require("tim-core");
function getDbPath() {
    const config = (0, tim_core_1.loadConfig)();
    return process.env.TIM_DB_PATH || config.dbPath || `${process.env.HOME}/.tim/tim.db`;
}
function parseSyncArgs(args) {
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                parsed[key] = next;
                i++;
            }
            else {
                parsed[key] = 'true';
            }
        }
    }
    return parsed;
}
async function promptHidden(rl, label) {
    return rl.question(label);
}
async function cmdSyncConnect(args) {
    const flags = parseSyncArgs(args);
    const rl = readline.createInterface({ input: node_process_1.stdin, output: node_process_1.stdout });
    try {
        const deviceId = (0, tim_sync_client_1.getDeviceId)();
        const fileId = (0, tim_sync_client_1.defaultFileId)(deviceId);
        const serverUrl = flags['server-url'] ?? ((await rl.question('Sync server URL [http://localhost:3100]: ')).trim()
            || 'http://localhost:3100');
        const clientProbe = new tim_sync_client_1.TimSyncClient(serverUrl, '');
        const healthy = await clientProbe.health();
        if (!healthy) {
            console.error(`Cannot reach sync server at ${serverUrl}`);
            process.exit(1);
        }
        let userId = flags['user-id']?.trim() ?? '';
        let token = flags.token?.trim() ?? '';
        if (flags.register === 'true' || (!token && !flags['user-id'])) {
            const tier = flags.tier === 'pro' ? 'pro' : 'free';
            const reg = await clientProbe.register(tier);
            token = reg.token;
            userId = reg.tenant_id;
            console.log(`✓ Registered tenant ${userId} (${reg.tier})`);
        }
        else {
            if (!userId) {
                userId = (await rl.question('User ID: ')).trim();
            }
            if (!userId) {
                console.error('User ID is required (or use --register)');
                process.exit(1);
            }
            if (!token)
                token = userId;
        }
        const passphrase = flags.passphrase
            ?? await promptHidden(rl, 'Passphrase: ');
        if (!passphrase) {
            console.error('Passphrase is required');
            process.exit(1);
        }
        const client = new tim_sync_client_1.TimSyncClient(serverUrl, token);
        const salt = (0, tim_sync_client_1.generateSalt)();
        try {
            await client.createFile(fileId, salt);
        }
        catch (e) {
            if (e instanceof tim_sync_client_1.SyncApiError && e.code === 'CONFLICT') {
                const files = await client.listFiles();
                const existing = files.find((f) => f.id === fileId);
                if (!existing?.salt) {
                    console.error('File exists but no salt returned — cannot decrypt');
                    process.exit(1);
                }
                (0, tim_sync_client_1.saveConfig)({
                    serverUrl,
                    userId,
                    token,
                    salt: existing.salt,
                    fileId,
                });
                console.log(`✓ Connected (existing file). File ID: ${fileId}`);
                return;
            }
            throw e;
        }
        (0, tim_sync_client_1.saveConfig)({ serverUrl, userId, token, salt, fileId });
        (0, tim_sync_client_1.saveSyncState)({ fileId, cursor: null, lastPush: null, lastPull: null });
        console.log(`✓ Connected. File ID: ${fileId}`);
    }
    finally {
        rl.close();
    }
}
function requirePassphrase(flags) {
    const p = process.env.TIM_SYNC_PASSPHRASE ?? flags.passphrase;
    if (!p) {
        console.error('Set TIM_SYNC_PASSPHRASE or pass --passphrase');
        process.exit(1);
    }
    return p;
}
async function cmdSyncPush(args) {
    const flags = parseSyncArgs(args);
    const config = (0, tim_sync_client_1.loadConfig)();
    if (!config) {
        console.error('Not connected. Run: tim sync connect');
        process.exit(1);
    }
    const passphrase = requirePassphrase(flags);
    const store = new tim_store_1.TimStore(getDbPath());
    try {
        const ctx = (0, tim_sync_client_1.buildSyncContext)(store, config, passphrase, (0, tim_sync_client_1.getDeviceId)());
        const { pushed, queued } = await (0, tim_sync_client_1.runPush)(ctx);
        console.log(`Pushed ${pushed} records${queued ? ' (more queued — retry push)' : ''}`);
    }
    finally {
        store.close();
    }
}
async function cmdSyncPull(args) {
    const flags = parseSyncArgs(args);
    const config = (0, tim_sync_client_1.loadConfig)();
    if (!config) {
        console.error('Not connected. Run: tim sync connect');
        process.exit(1);
    }
    const passphrase = requirePassphrase(flags);
    const store = new tim_store_1.TimStore(getDbPath());
    try {
        const ctx = (0, tim_sync_client_1.buildSyncContext)(store, config, passphrase, (0, tim_sync_client_1.getDeviceId)());
        const { pulled, conflicts } = await (0, tim_sync_client_1.runPull)(ctx);
        console.log(`Pulled ${pulled} records, ${conflicts} conflicts`);
    }
    finally {
        store.close();
    }
}
async function cmdSyncStatus() {
    const config = (0, tim_sync_client_1.loadConfig)();
    const state = (0, tim_sync_client_1.loadSyncState)();
    const timDir = (0, tim_core_1.getTimDir)();
    if (!config) {
        console.log('Sync: not configured (run tim sync connect)');
        return;
    }
    const client = new tim_sync_client_1.TimSyncClient(config.serverUrl, config.token);
    const healthy = await client.health();
    let remoteStatus = {};
    try {
        remoteStatus = await client.syncStatus();
    }
    catch {
        /* legacy dev server may not expose /sync/status */
    }
    let unacked = 0;
    if (fs.existsSync(getDbPath())) {
        const store = new tim_store_1.TimStore(getDbPath());
        try {
            unacked = (0, tim_store_2.getUnackedStaging)(store.getDb()).length;
        }
        finally {
            store.close();
        }
    }
    console.log('═══ TIM Sync Status ═══');
    console.log(`Server: ${config.serverUrl} (${healthy ? '✓ reachable' : '✗ unreachable'})`);
    console.log(`User: ${config.userId}`);
    console.log(`File ID: ${config.fileId}`);
    console.log(`Device ID: ${(0, tim_sync_client_1.getDeviceId)()}`);
    console.log(`Unacked staging: ${unacked}`);
    console.log(`Last push: ${state?.lastPush ?? 'never'}`);
    console.log(`Last pull: ${state?.lastPull ?? 'never'}`);
    console.log(`Cursor: ${state?.cursor ?? '(none)'}`);
    console.log(`Config: ${timDir}/sync.json`);
    if (remoteStatus.tier) {
        console.log(`Tier: ${remoteStatus.tier}`);
        console.log(`Remote entries: ${remoteStatus.entry_count ?? 0}`);
        console.log(`Remote bytes: ${remoteStatus.total_bytes ?? 0}`);
    }
}
function cmdSyncDisconnect() {
    const removed = (0, tim_sync_client_1.clearSyncConnection)();
    if (removed.config || removed.state) {
        const parts = [];
        if (removed.config)
            parts.push('sync.json');
        if (removed.state)
            parts.push('sync-state.json');
        console.log(`✓ Disconnected — removed ${parts.join(' and ')}`);
    }
    else {
        console.log('Sync: not configured');
    }
}
async function cmdSyncDev(args) {
    const flags = parseSyncArgs(args);
    const port = parseInt(flags.port ?? '3100', 10);
    (0, tim_sync_client_1.startDevServer)(port);
}
async function cmdSync(sub, args) {
    switch (sub) {
        case 'connect':
            await cmdSyncConnect(args);
            break;
        case 'push':
            await cmdSyncPush(args);
            break;
        case 'pull':
            await cmdSyncPull(args);
            break;
        case 'status':
            await cmdSyncStatus();
            break;
        case 'disconnect':
            cmdSyncDisconnect();
            break;
        case 'dev':
            await cmdSyncDev(args);
            break;
        default:
            console.error(`Unknown sync command: ${sub ?? '(none)'}`);
            console.error('Usage: tim sync <connect|disconnect|push|pull|status|dev> [options]');
            process.exit(1);
    }
}
//# sourceMappingURL=sync-cli.js.map