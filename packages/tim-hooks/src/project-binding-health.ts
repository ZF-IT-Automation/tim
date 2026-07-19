import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TimStore,
  DEFAULT_STALE_PATH_MAX_AGE_DAYS,
  isStalePathRow,
  listProjectPathRows,
} from 'tim-store';
import { readMarker } from './marker.js';
import {
  recoverProjectBinding,
  type ProjectCreationDeps,
} from './project-creation.js';

export type ProjectBindingStatus =
  | 'bound'
  | 'unbound'
  | 'label-mismatch'
  | 'path-missing'
  | 'no-path';

export interface ProjectBindingFinding {
  label: string;
  path?: string;
  status: ProjectBindingStatus;
  markerLabel?: string;
}

export interface StalePathFinding {
  label: string;
  path: string;
  device: string;
  lastSeenAt?: string;
}

export interface BindingReport {
  projects: ProjectBindingFinding[];
  stalePaths: StalePathFinding[];
}

export interface BindOutcome {
  label: string;
  outcome: 'bound' | 'already-bound' | 'failed';
  detail?: string;
}

export function bindingDeviceId(): string {
  return os.hostname();
}

/** Classify a project's on-disk binding from store metadata.path. */
export function classifyProjectPathBinding(
  label: string,
  projectPath: string | undefined,
): Pick<ProjectBindingFinding, 'status' | 'markerLabel'> {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return { status: 'no-path' };
  }

  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) {
    return { status: 'path-missing' };
  }

  const marker = readMarker(resolved);
  if (!marker) {
    return { status: 'unbound' };
  }
  if (marker.project === label) {
    return { status: 'bound' };
  }
  return { status: 'label-mismatch', markerLabel: marker.project };
}

export async function collectBindingReport(store: TimStore): Promise<BindingReport> {
  const projects: ProjectBindingFinding[] = [];
  const stalePaths: StalePathFinding[] = [];
  const device = bindingDeviceId();
  const now = Date.now();

  for (const row of await store.listProjects()) {
    const entry = await store.read(row.id);
    if (!entry || entry.metadata.kind !== 'project') continue;

    const projectPath =
      typeof entry.metadata.path === 'string' ? entry.metadata.path : undefined;
    const classification = classifyProjectPathBinding(row.label, projectPath);
    projects.push({
      label: row.label,
      path: projectPath,
      ...classification,
    });

    for (const pathRow of await listProjectPathRows(store, row.label)) {
      if (pathRow.metadata.device !== device) continue;
      if (!isStalePathRow(pathRow, now, DEFAULT_STALE_PATH_MAX_AGE_DAYS)) continue;
      const inventoryPath =
        typeof pathRow.metadata.path === 'string' ? pathRow.metadata.path : '';
      stalePaths.push({
        label: row.label,
        path: inventoryPath,
        device,
        lastSeenAt:
          typeof pathRow.metadata.last_seen_at === 'string'
            ? pathRow.metadata.last_seen_at
            : undefined,
      });
    }
  }

  projects.sort((a, b) => a.label.localeCompare(b.label));
  stalePaths.sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
  return { projects, stalePaths };
}

export function formatBindingFindingLine(finding: ProjectBindingFinding): string {
  switch (finding.status) {
    case 'no-path':
      return `  ${finding.label} no-path`;
    case 'path-missing':
      return `  ${finding.label} ${finding.path} path-missing`;
    case 'label-mismatch':
      return `  ${finding.label} ${finding.path} label-mismatch (marker ${finding.markerLabel})`;
  }
  return `  ${finding.label} ${finding.path} ${finding.status}`;
}

export function formatStalePathLine(finding: StalePathFinding): string {
  const seen = finding.lastSeenAt ?? 'unknown';
  return `  stale ${finding.label} ${finding.path} (${finding.device}, last seen ${seen})`;
}

export function formatBindOutcomeLine(outcome: BindOutcome): string {
  if (outcome.outcome === 'failed') {
    return `  ${outcome.label}: failed (${outcome.detail ?? 'unknown error'})`;
  }
  return `  ${outcome.label}: ${outcome.outcome}`;
}

export async function bindUnboundBindings(
  store: TimStore,
  findings: ProjectBindingFinding[],
  deps: Partial<ProjectCreationDeps> = {},
): Promise<BindOutcome[]> {
  const outcomes: BindOutcome[] = [];
  for (const finding of findings) {
    if (finding.status !== 'unbound' || !finding.path) continue;
    try {
      const result = await recoverProjectBinding(
        store,
        { label: finding.label, path: finding.path },
        deps,
      );
      outcomes.push({
        label: finding.label,
        outcome: result.alreadyBound ? 'already-bound' : 'bound',
      });
    } catch (error) {
      outcomes.push({
        label: finding.label,
        outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
