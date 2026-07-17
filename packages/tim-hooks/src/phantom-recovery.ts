import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TimStore } from 'tim-store';
import {
  CANONICAL_PROJECT_FILENAME,
  validateMarkerAgainstStore,
  validateProjectLabel,
  type ProjectMarker,
} from './marker.js';

function readTimJsonProjectLabel(dir: string): string | null {
  const filePath = path.join(dir, CANONICAL_PROJECT_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const label = raw.project;
    return typeof label === 'string' && validateProjectLabel(label) ? label : null;
  } catch {
    return null;
  }
}

async function labelIfValidProject(
  store: TimStore,
  label: string,
): Promise<string | null> {
  const validated = await validateMarkerAgainstStore(
    {
      version: 2,
      project: label,
      session: '',
      exchanges: 0,
      batch_size: 5,
      batches_summarized: 0,
    },
    store,
  );
  return validated?.project ?? null;
}

/**
 * Attempt to recover a real project label when `.tim-project` points at a
 * phantom (pattern-valid label missing from the DB).
 */
export async function repairPhantomProjectBinding(
  store: TimStore,
  dir: string,
): Promise<string | null> {
  const resolvedDir = path.resolve(dir);

  const fromTimJson = readTimJsonProjectLabel(resolvedDir);
  if (fromTimJson) {
    const label = await labelIfValidProject(store, fromTimJson);
    if (label) return label;
  }

  const byPath = await store.findProjectByPath(resolvedDir);
  if (byPath && byPath.metadata.kind === 'project' && !byPath.irrelevant) {
    const label = typeof byPath.metadata.label === 'string'
      ? byPath.metadata.label
      : byPath.id;
    return label;
  }

  const alias = path.basename(resolvedDir).toLowerCase();
  if (alias) {
    const resolved = await store.resolveProjectLabel(alias);
    if (resolved.status === 'found') {
      const entry = await store.read(resolved.label);
      if (entry?.metadata.kind === 'project' && !entry.irrelevant) {
        return resolved.label;
      }
    }
    // ambiguous → leave unrepaired (caller must not mint another contested alias)
  }

  return null;
}

/** Strip trailing `?` from statusline unbound display labels. */
export function stripUnboundProjectSuffix(label: string): string {
  return label.endsWith('?') ? label.slice(0, -1) : label;
}

export function formatUnboundProjectLabel(label: string): string {
  return label.endsWith('?') ? label : `${label}?`;
}

export function isUnboundProjectLabel(label: string): boolean {
  return label.endsWith('?');
}

export function markerWithRepairedProject(
  marker: ProjectMarker,
  recoveredLabel: string,
): ProjectMarker {
  return { ...marker, project: recoveredLabel };
}
