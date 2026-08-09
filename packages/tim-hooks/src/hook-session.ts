import type { TimStore } from 'tim-store';
import type { SessionManager } from 'tim-store';
import { findMarker } from './marker.js';

/**
 * Turn-end hooks are the first thing to touch a session for harnesses whose
 * session node is never created any other way, so they register it themselves
 * from the nearest .tim-project marker.
 */
export async function ensureHookSession(
  store: TimStore,
  sessions: SessionManager,
  sessionId: string,
  cwd: string,
  agent: { agentName: string; harness: string },
): Promise<boolean> {
  const existing = await store.read(sessionId);
  if (existing?.metadata.kind === 'session') return true;

  const marker = findMarker(cwd)?.marker;
  if (!marker?.project) return false;

  try {
    await sessions.startProjectSession({
      sessionId,
      projectId: marker.project,
      agentName: agent.agentName,
      cwd,
      harness: agent.harness,
    });
    return true;
  } catch {
    return false;
  }
}
