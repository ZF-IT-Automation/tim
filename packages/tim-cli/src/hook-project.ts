import { findMarker } from 'tim-hooks';
import type { TimStore } from 'tim-store';

/**
 * Project a turn hook should use. A bound session (`kind === 'session'` and a
 * string `project_ref`) wins over cwd: Claude's cwd drifts into subdirectories
 * where the cwd-only marker lookup finds nothing. No session entry → the marker
 * in cwd itself. No walk-up.
 */
export async function resolveHookProject(
  store: TimStore,
  sessionId: string,
  cwd: string,
): Promise<string | undefined> {
  const session = sessionId ? await store.read(sessionId) : null;
  const bound = session?.metadata.kind === 'session' && typeof session.metadata.project_ref === 'string'
    ? session.metadata.project_ref
    : undefined;
  return bound ?? findMarker(cwd)?.marker.project;
}
