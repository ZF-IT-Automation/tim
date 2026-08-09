"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureHookSession = ensureHookSession;
const marker_js_1 = require("./marker.js");
/**
 * Turn-end hooks are the first thing to touch a session for harnesses whose
 * session node is never created any other way, so they register it themselves
 * from the nearest .tim-project marker.
 */
async function ensureHookSession(store, sessions, sessionId, cwd, agent) {
    const existing = await store.read(sessionId);
    if (existing?.metadata.kind === 'session')
        return true;
    const marker = (0, marker_js_1.findMarker)(cwd)?.marker;
    if (!marker?.project)
        return false;
    try {
        await sessions.startProjectSession({
            sessionId,
            projectId: marker.project,
            agentName: agent.agentName,
            cwd,
            harness: agent.harness,
        });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=hook-session.js.map