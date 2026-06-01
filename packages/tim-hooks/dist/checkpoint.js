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
const marker_js_1 = require("./marker.js");
const session_hooks_js_1 = require("./session-hooks.js");
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
async function resolveSessionProjectId(store, cwd, explicitProjectId) {
    if (explicitProjectId)
        return explicitProjectId;
    const marker = (0, marker_js_1.detectProject)(cwd);
    if (marker)
        return marker.project;
    const active = getActiveProjectLabel();
    if (active)
        return active;
    await (0, tim_store_1.ensureInboxProject)(store);
    return tim_store_1.INBOX_PROJECT_LABEL;
}
async function runCheckpoint(store, sessionId, opts = {}) {
    const sessions = new tim_store_1.SessionManager(store);
    return sessions.checkpoint(sessionId, opts);
}
async function runSessionStart(store, params) {
    const sessions = new tim_store_1.SessionManager(store);
    const projectId = await resolveSessionProjectId(store, params.cwd, params.projectId);
    const session = await sessions.startProjectSession({
        sessionId: params.sessionId,
        projectId,
        agentName: params.agentName,
        cwd: params.cwd,
        harness: params.harness,
        batchSize: params.batchSize,
    });
    (0, marker_js_1.writeMarker)(params.cwd, {
        project: projectId,
        session: params.sessionId,
        exchanges: 0,
        batch_size: typeof session.metadata.batch_size === 'number'
            ? session.metadata.batch_size
            : 5,
        batches_summarized: 0,
        summarizer: session.metadata.summarizer,
    });
    await (0, hooks_js_1.runConfiguredHooks)('sessionStart', params.hooksConfig, {
        TIM_SESSION_ID: params.sessionId,
        TIM_CWD: params.cwd,
        TIM_AGENT: params.agentName,
        TIM_HARNESS: params.harness,
        TIM_PROJECT: projectId,
    });
    const project = await store.read(projectId);
    return { session, project };
}
async function runSessionEnd(store, sessionId, opts = {}) {
    const cwd = opts.env?.TIM_CWD ?? process.cwd();
    const env = {
        TIM_SESSION_ID: sessionId,
        TIM_CWD: cwd,
        ...opts.env,
    };
    await (0, hooks_js_1.runConfiguredHooks)('sessionEnd', opts.hooksConfig, env);
    await (0, session_hooks_js_1.onSessionStop)(store, cwd);
    return runCheckpoint(store, sessionId, {
        summarize: opts.summarize,
    });
}
//# sourceMappingURL=checkpoint.js.map