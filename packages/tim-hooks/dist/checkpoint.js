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
exports.getActiveProjectLabel = getActiveProjectLabel;
exports.loadProjectContext = loadProjectContext;
exports.runCheckpoint = runCheckpoint;
exports.runSessionStart = runSessionStart;
exports.runSessionEnd = runSessionEnd;
const tim_core_1 = require("tim-core");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_store_1 = require("tim-store");
const hooks_js_1 = require("./hooks.js");
/** Resolve active project label from TIM_PROJECT env or ~/.tim/active-project. */
function getActiveProjectLabel() {
    const fromEnv = process.env.TIM_PROJECT?.trim();
    if (fromEnv)
        return fromEnv;
    const activeFile = path.join((0, tim_core_1.getTimDir)(), 'active-project');
    if (!fs.existsSync(activeFile))
        return null;
    const label = fs.readFileSync(activeFile, 'utf8').trim();
    return label || null;
}
/** Load project entry by hmem-style label (e.g. P0062) when configured. */
async function loadProjectContext(store) {
    const label = getActiveProjectLabel();
    if (!label)
        return null;
    return store.read(label);
}
async function runCheckpoint(store, sessionId, opts = {}) {
    const sessions = new tim_store_1.SessionManager(store);
    return sessions.checkpoint(sessionId, opts);
}
async function runSessionStart(store, params) {
    const sessions = new tim_store_1.SessionManager(store);
    const session = await sessions.sessionStart({
        sessionId: params.sessionId,
        agentName: params.agentName,
        cwd: params.cwd,
        harness: params.harness,
    });
    await (0, hooks_js_1.runConfiguredHooks)('sessionStart', params.hooksConfig, {
        TIM_SESSION_ID: params.sessionId,
        TIM_CWD: params.cwd,
        TIM_AGENT: params.agentName,
        TIM_HARNESS: params.harness,
    });
    const project = await loadProjectContext(store);
    return { session, project };
}
async function runSessionEnd(store, sessionId, opts = {}) {
    const env = {
        TIM_SESSION_ID: sessionId,
        ...opts.env,
    };
    await (0, hooks_js_1.runConfiguredHooks)('sessionEnd', opts.hooksConfig, env);
    return runCheckpoint(store, sessionId, {
        summarize: opts.summarize,
    });
}
//# sourceMappingURL=checkpoint.js.map