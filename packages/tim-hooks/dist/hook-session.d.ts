import type { TimStore } from 'tim-store';
import type { SessionManager } from 'tim-store';
/**
 * Turn-end hooks are the first thing to touch a session for harnesses whose
 * session node is never created any other way, so they register it themselves
 * from the nearest .tim-project marker.
 */
export declare function ensureHookSession(store: TimStore, sessions: SessionManager, sessionId: string, cwd: string, agent: {
    agentName: string;
    harness: string;
}): Promise<boolean>;
//# sourceMappingURL=hook-session.d.ts.map