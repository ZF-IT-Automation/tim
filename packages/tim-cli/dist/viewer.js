"use strict";
// `tim viewer` — local, read-only browser UI over the entry tree.
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
exports.cmdViewer = cmdViewer;
const tim_core_1 = require("tim-core");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const args_js_1 = require("./args.js");
const viewer_server_js_1 = require("./viewer-server.js");
const DEFAULT_PORT = 7373;
function getDbPath(config) {
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
async function cmdViewer(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('viewer') });
    const dbPath = flags.db || getDbPath((0, tim_core_1.loadConfig)());
    const host = flags.host || '127.0.0.1';
    const showSecrets = flags['show-secrets'] === 'true';
    const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`Invalid --port "${flags.port}" (expected 0-65535)`);
        process.exit(1);
    }
    // The store opens read-only with fileMustExist — report the missing file
    // ourselves rather than surfacing a raw SQLite error.
    if (!fs.existsSync(dbPath)) {
        console.error(`TIM database not found: ${dbPath}\nRun 'tim init' first, or pass --db <path>.`);
        process.exit(1);
    }
    let handle;
    try {
        handle = await (0, viewer_server_js_1.startViewer)({ dbPath, port, host, showSecrets });
    }
    catch (err) {
        if (err instanceof viewer_server_js_1.NonLoopbackBindError) {
            console.error(err.message);
            process.exit(1);
        }
        throw err;
    }
    console.log(`TIM viewer (read-only) → ${handle.url}`);
    console.log(`  database: ${dbPath}`);
    console.log(showSecrets
        ? '  secrets:  SHOWN — secret-marked subtrees render in full'
        : '  secrets:  redacted (structure only) — pass --show-secrets to render them');
    console.log('  Ctrl-C to stop.');
    const stop = () => {
        void handle.close().then(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
//# sourceMappingURL=viewer.js.map