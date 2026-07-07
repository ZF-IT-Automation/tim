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
exports.cmdUserInit = cmdUserInit;
exports.cmdUserProfile = cmdUserProfile;
exports.cmdUpdateSkills = cmdUpdateSkills;
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
function getDbPath() {
    const config = (0, tim_core_1.loadConfig)();
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
async function cmdUserInit() {
    const store = new tim_store_1.TimStore(getDbPath());
    try {
        const profile = await (0, tim_store_1.ensureHumanProfile)(store);
        console.log(`✓ Human profile ready: ${profile.root.title}`);
        for (const s of profile.sections) {
            console.log(`  - ${s.title}`);
        }
    }
    finally {
        store.close();
    }
}
async function cmdUserProfile() {
    const store = new tim_store_1.TimStore(getDbPath());
    try {
        const summary = await (0, tim_store_1.getHumanProfileSummary)(store);
        console.log(summary);
    }
    finally {
        store.close();
    }
}
async function cmdUpdateSkills() {
    const { updateSkills } = await import('./update-skills.js');
    const result = updateSkills();
    for (const c of result.copied) {
        console.log(`✓ ${c.skill} → ${c.target}`);
    }
    for (const s of result.skipped) {
        console.log(`⊘ ${s}`);
    }
}
//# sourceMappingURL=user.js.map