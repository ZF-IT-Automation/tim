import * as fs from 'fs';
import * as path from 'path';
import type { TimStore } from 'tim-store';
import { deriveCounters } from 'tim-store';

export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';

export interface SummarizerConfig {
  cli: string;
  model: string;
}

export interface ProjectMarker {
  project: string;
  session: string;
  exchanges: number;
  batch_size: number;
  batches_summarized: number;
  summarizer?: SummarizerConfig;
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

/**
 * Walk up from `startCwd` to the filesystem root and return the NEAREST
 * `.tim-project` (closest ancestor wins). Pure FS — no store, no network —
 * so it is safe to call from a hook under a tight timeout.
 *
 * If the nearest marker FILE exists but is unparseable, we STOP and return
 * null rather than silently binding an ancestor's project.
 */
export function findMarker(startCwd: string): MarkerLocation | null {
  let dir = path.resolve(startCwd);
  for (let i = 0; i < 256; i++) {
    if (fs.existsSync(markerPath(dir))) {
      const marker = readMarker(dir); // null when corrupt
      return marker ? { marker, dir } : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Shared, harness-agnostic directive text. Every start hook (Hermes,
 * Claude Code, Cursor) emits exactly this so wording stays DRY. The TIM
 * marker is authoritative for project binding this turn (see plan §end-state).
 */
export function buildLoadDirective(label: string, markerDir: string): string {
  return [
    `📍 TIM project marker detected (.tim-project in ${markerDir}).`,
    `This session is bound to TIM project ${label}.`,
    ``,
    `ACTION: call tim_load_project(label="${label}") now to load the project ` +
      `brief from the TIM store, then run the o9k-session-start skill. STEP 1 ` +
      `(project binding) is already decided by this marker — do NOT ask which ` +
      `project, and do NOT run any hmem/active-project cwd→project resolution. ` +
      `The TIM marker is authoritative for this turn.`,
  ].join('\n');
}
