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
exports.detachedSpawner = void 0;
exports.onSessionStop = onSessionStop;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const marker_js_1 = require("./marker.js");
const detachedSpawner = (command, ctx) => {
    const child = (0, child_process_1.spawn)(command, {
        shell: true,
        cwd: ctx.cwd,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TIM_SESSION_ID: ctx.sessionId },
    });
    child.unref();
};
exports.detachedSpawner = detachedSpawner;
function buildSummarizerCommand(cfg, sessionId, lockPath) {
    const cli = cfg?.cli ?? 'claude';
    const model = cfg?.model ?? 'haiku';
    const prompt = `Summarize TIM session ${sessionId}: repeatedly call tim_show_unsummarized({sessionId:"${sessionId}"}), ` +
        `summarize each returned batch thematically, and tim_write the summary as a Batch node under summaryNodeId ` +
        `with metadata.kind="batch-summary". Stop when hasMore is false.`;
    return `${cli} -p --model ${model} ${JSON.stringify(prompt)} ; rm -f ${JSON.stringify(lockPath)}`;
}
async function onSessionStop(store, cwd, opts = {}) {
    const spawn = opts.spawn ?? exports.detachedSpawner;
    const marker = (0, marker_js_1.detectProject)(cwd);
    if (!marker)
        return { spawned: false, reason: 'no-marker' };
    const reconciled = await (0, marker_js_1.reconcileMarker)(store, cwd);
    const pending = reconciled.exchanges - reconciled.batches_summarized * reconciled.batch_size;
    if (pending < reconciled.batch_size) {
        return { spawned: false, reason: 'below-threshold', pending };
    }
    if (!(0, marker_js_1.acquireLock)(cwd))
        return { spawned: false, reason: 'locked', pending };
    const lockPath = path.join(cwd, marker_js_1.MARKER_LOCK);
    spawn(buildSummarizerCommand(reconciled.summarizer, reconciled.session, lockPath), {
        sessionId: reconciled.session,
        cwd,
    });
    return { spawned: true, reason: 'spawned', pending };
}
//# sourceMappingURL=session-hooks.js.map