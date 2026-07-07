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
exports.cmdSecret = cmdSecret;
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
function getDbPath(config) {
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
async function cmdSecret(args) {
    const sub = args[0];
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    const db = store.getDb();
    try {
        switch (sub) {
            case 'set': {
                const id = args[1];
                if (!id) {
                    console.error('Usage: tim secret set <id>');
                    process.exit(1);
                }
                const exists = db.prepare('SELECT id FROM entries WHERE id = ?').get(id);
                if (!exists) {
                    console.error(`Entry not found: ${id}`);
                    process.exit(1);
                }
                const count = await (0, tim_store_1.setSecretSubtree)(store, id);
                console.log(`✓ Secret set on ${id} (+${count - 1} descendants)`);
                break;
            }
            case 'status': {
                const id = args[1];
                if (!id) {
                    console.error('Usage: tim secret status <id>');
                    process.exit(1);
                }
                const row = db.prepare('SELECT parent_id FROM entries WHERE id = ?').get(id);
                if (!row) {
                    console.error(`Entry not found: ${id}`);
                    process.exit(1);
                }
                if (!(0, tim_store_1.isSecret)(db, id)) {
                    console.log('secret: false');
                    break;
                }
                if (row.parent_id && (0, tim_store_1.parentIsSecret)(db, row.parent_id)) {
                    const source = (0, tim_store_1.findSecretSource)(db, row.parent_id);
                    console.log(`secret: true (inherited from ${source})`);
                }
                else {
                    console.log('secret: true (own)');
                }
                break;
            }
            case 'list': {
                const rows = db.prepare(`
          SELECT id, title, metadata, parent_id FROM entries
          WHERE json_extract(metadata, '$.secret') = 1
            AND tombstoned_at IS NULL
          ORDER BY id
        `).all();
                if (rows.length === 0) {
                    console.log('No secret entries.');
                    break;
                }
                console.log('ID\tTitle\tInherited');
                for (const row of rows) {
                    const title = row.title.length > 40 ? `${row.title.slice(0, 37)}...` : row.title;
                    const inherited = row.parent_id && (0, tim_store_1.parentIsSecret)(db, row.parent_id) ? 'yes' : 'no';
                    console.log(`${row.id}\t${title}\t${inherited}`);
                }
                break;
            }
            default:
                console.error('Usage: tim secret <set|status|list> ...');
                console.error('Note: secret is one-directional — there is no unset command.');
                process.exit(1);
        }
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=secret.js.map