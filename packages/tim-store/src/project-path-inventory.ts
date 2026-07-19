import type { Entry } from 'tim-core';
import * as path from 'path';
import type { TimStore } from './store.js';

export const KIND_PROJECT_PATH = 'project-path';

/** Default staleness threshold for project-path inventory rows (days). */
export const DEFAULT_STALE_PATH_MAX_AGE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** List all project-path inventory rows for a project. */
export async function listProjectPathRows(
  store: TimStore,
  projectId: string,
): Promise<Entry[]> {
  const project = await store.requireProject(projectId);
  return store.getChildByKind(project.id, KIND_PROJECT_PATH);
}

/** Upsert a per-device path observation under the project root. */
export async function upsertProjectPathRow(
  store: TimStore,
  projectId: string,
  device: string,
  absPath: string,
): Promise<Entry> {
  const project = await store.requireProject(projectId);
  const resolvedPath = path.resolve(absPath);
  const now = new Date().toISOString();

  const existingRows = await listProjectPathRows(store, project.id);
  const match = existingRows.find(
    row =>
      row.metadata.device === device &&
      typeof row.metadata.path === 'string' &&
      path.resolve(row.metadata.path) === resolvedPath,
  );

  if (match) {
    return store.update(match.id, {
      metadata: { ...match.metadata, last_seen_at: now },
    });
  }

  return store.write(`${device}: ${resolvedPath}`, {
    parentId: project.id,
    metadata: {
      kind: KIND_PROJECT_PATH,
      device,
      path: resolvedPath,
      last_seen_at: now,
    },
  });
}

/** True when last_seen_at is older than maxAgeDays (default 30). */
export function isStalePathRow(
  row: Entry,
  now: number = Date.now(),
  maxAgeDays: number = DEFAULT_STALE_PATH_MAX_AGE_DAYS,
): boolean {
  const lastSeen = row.metadata.last_seen_at;
  if (typeof lastSeen !== 'string') return true;
  const ageMs = now - new Date(lastSeen).getTime();
  return ageMs > maxAgeDays * MS_PER_DAY;
}
