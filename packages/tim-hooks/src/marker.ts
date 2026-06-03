import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TimStore } from 'tim-store';
import { deriveCounters } from 'tim-store';

export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';

export interface ProjectMarker {
  project: string;
  session: string;
  exchanges: number;
  batch_size: number;
  batches_summarized: number;
  /** Global ~/.tim-project only: last project label loaded via tim_load_project */
  route_exchanges_to?: string;
  /** Global ~/.tim-project only: project label → harness session id */
  sessions?: Record<string, string>;
}

export function markerPath(cwd: string): string {
  return path.join(cwd, MARKER_FILENAME);
}

export function readMarker(cwd: string): ProjectMarker | null {
  const p = markerPath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ProjectMarker;
  } catch {
    return null;
  }
}

export function writeMarker(cwd: string, marker: ProjectMarker): void {
  fs.writeFileSync(markerPath(cwd), JSON.stringify(marker, null, 2));
}

/**
 * Update the nearest `.tim-project` (walk-up from cwd) after tim_load_project.
 * Statusline and hooks read this marker — must match the loaded project label.
 */
export function syncNearestProjectMarker(
  startCwd: string,
  projectLabel: string,
  options?: { sessionId?: string; findOptions?: FindMarkerOptions },
): boolean {
  const located = findMarker(startCwd, options?.findOptions);
  if (!located) return false;
  const sessionId = options?.sessionId?.trim();
  writeMarker(located.dir, {
    ...located.marker,
    project: projectLabel,
    ...(sessionId ? { session: sessionId } : {}),
  });
  return true;
}

/** Project detection — v1: .tim-project marker only. */
export function detectProject(cwd: string): ProjectMarker | null {
  return readMarker(cwd);
}

/** Re-derive counters from the DB and persist them into the marker. */
export async function reconcileMarker(store: TimStore, cwd: string): Promise<ProjectMarker> {
  const marker = readMarker(cwd);
  if (!marker) throw new Error(`No ${MARKER_FILENAME} in ${cwd}`);
  const { exchangeCount, batchesSummarized } = await deriveCounters(store, marker.session);
  const reconciled: ProjectMarker = {
    ...marker,
    exchanges: exchangeCount,
    batches_summarized: batchesSummarized,
  };
  writeMarker(cwd, reconciled);
  return reconciled;
}

export const LOCK_TTL_MS = 10 * 60_000;

export function acquireLock(cwd: string): boolean {
  const lock = path.join(cwd, MARKER_LOCK);
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
    return true;
  } catch {
    try {
      const raw = JSON.parse(fs.readFileSync(lock, 'utf8')) as { ts: number };
      if (Date.now() - raw.ts > LOCK_TTL_MS) {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
        return true;
      }
    } catch {
      /* unreadable lock → treat as held */
    }
    return false;
  }
}

/** True when an active (non-stale) summarizer/session lock is held. */
export function isSessionLocked(cwd: string): boolean {
  const lock = path.join(cwd, MARKER_LOCK);
  if (!fs.existsSync(lock)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(lock, 'utf8')) as { ts: number };
    return Date.now() - raw.ts <= LOCK_TTL_MS;
  } catch {
    return true;
  }
}

export function releaseLock(cwd: string): void {
  try {
    fs.rmSync(path.join(cwd, MARKER_LOCK), { force: true });
  } catch {
    /* ignore */
  }
}

export interface MarkerLocation {
  marker: ProjectMarker;
  dir: string;
}

export interface FindMarkerOptions {
  /** Do not walk above this directory (isolates tests; ignores e.g. /tmp/.tim-project). */
  maxRoot?: string;
}

function isInsideRoot(dir: string, root: string): boolean {
  const d = path.resolve(dir);
  const r = path.resolve(root);
  return d === r || d.startsWith(r + path.sep);
}

/** Test helper: TIM_MARKER_MAX_ROOT limits walk-up scope for spawned CLI. */
export function findMarkerOptionsFromEnv(): FindMarkerOptions | undefined {
  const maxRoot = process.env.TIM_MARKER_MAX_ROOT?.trim();
  return maxRoot ? { maxRoot } : undefined;
}

function pickMarkerLocation(candidates: MarkerLocation[]): MarkerLocation {
  const homeDir = path.resolve(os.homedir());
  const nonHome = candidates.filter((loc) => path.resolve(loc.dir) !== homeDir);
  const pool = nonHome.length > 0 ? nonHome : candidates;
  return pool.reduce((best, cur) =>
    path.resolve(cur.dir).length > path.resolve(best.dir).length ? cur : best,
  );
}

/**
 * Walk up from `startCwd` and return the deepest `.tim-project` on that chain.
 * When both a repo marker and `~/.tim-project` exist, the home marker is skipped.
 * Pure FS — no store, no network — safe for hooks under a tight timeout.
 *
 * If a marker FILE exists but is unparseable, we STOP and return null rather than
 * silently binding an ancestor's project.
 */
export function findMarker(startCwd: string, options?: FindMarkerOptions): MarkerLocation | null {
  const maxRoot = options?.maxRoot ? path.resolve(options.maxRoot) : null;
  let dir = path.resolve(startCwd);
  const found: MarkerLocation[] = [];
  for (let i = 0; i < 256; i++) {
    if (fs.existsSync(markerPath(dir))) {
      const marker = readMarker(dir); // null when corrupt
      if (!marker) return null;
      found.push({ marker, dir });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    if (maxRoot && isInsideRoot(dir, maxRoot) && !isInsideRoot(parent, maxRoot)) break;
    dir = parent;
  }
  return found.length > 0 ? pickMarkerLocation(found) : null;
}

/**
 * Shared, harness-agnostic directive text. Every start hook (Hermes,
 * Claude Code, Cursor) emits exactly this so wording stays DRY. The TIM
 * marker is authoritative for project binding this turn (see plan §end-state).
 */
export function buildLoadDirective(
  projectLabel: string,
  markerDir: string,
  bindingLabel?: string,
): string {
  const display = bindingLabel?.trim() || projectLabel;
  return [
    `📍 TIM project marker detected (.tim-project in ${markerDir}).`,
    `This session is bound to TIM project ${display}.`,
    ``,
    `ACTION: call tim_load_project(label="${projectLabel}") now to load the project ` +
      `brief from the TIM store, then run the o9k-session-start skill. STEP 1 ` +
      `(project binding) is already decided by this marker — do NOT ask which ` +
      `project, and do NOT run any hmem/active-project cwd→project resolution. ` +
      `The TIM marker is authoritative for this turn.`,
  ].join('\n');
}

/** Directive when project comes from TIM session metadata (no local .tim-project). */
export function buildSessionDirective(
  projectLabel: string,
  cwd: string,
  bindingLabel?: string,
): string {
  const display = bindingLabel?.trim() || projectLabel;
  return [
    `📍 TIM session bound to project ${display} (TIM store, cwd ${cwd}).`,
    `This session is bound to TIM project ${display}.`,
    ``,
    `ACTION: call tim_load_project(label="${projectLabel}") now to load the project ` +
      `brief from the TIM store, then run the o9k-session-start skill. STEP 1 ` +
      `is already decided by this TIM session — do NOT ask which project, and do NOT ` +
      `run any hmem/active-project cwd→project resolution. The TIM binding is authoritative ` +
      `for this turn.`,
  ].join('\n');
}
