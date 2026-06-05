import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TimStore } from 'tim-store';
import { deriveCounters } from 'tim-store';

export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';

/**
 * Current marker schema version. Bump this when the on-disk shape changes;
 * readers detect older files by the missing/unknown `version` field and
 * normalize to the current shape.
 */
export const MARKER_VERSION = 2;

/**
 * .tim-project — v2 schema.
 *
 * v2 removed the legacy `route_exchanges_to` and `sessions` map fields
 * (hmem-era cruft: written by the MCP server, read by nothing). See
 * `references/sql-to-mcp-mapping.md` and the schema evaluation journal
 * for the field-by-field rationale.
 *
 * `version` is required on disk; the read path fills it in automatically
 * for v1 files so existing installations keep working without an explicit
 * migration step. The next write upgrades the file to v2.
 */
export interface ProjectMarker {
  version: 2;
  project: string;
  session: string;
  exchanges: number;
  batch_size: number;
  batches_summarized: number;
}

/**
 * Input shape for writeMarker. Callers MAY omit `version` — the writer
 * always stamps the current version on disk. All other fields are required.
 * Kept as a separate alias so the read API can return the strict v2 type
 * while the write API stays convenient for callers that don't care about
 * the version field.
 */
export type ProjectMarkerInput = Omit<ProjectMarker, 'version'> & {
  version?: 2;
};

export function markerPath(cwd: string): string {
  return path.join(cwd, MARKER_FILENAME);
}

/**
 * Read a marker and normalize it to the current schema version.
 *
 * - Missing file → null
 * - Corrupt JSON → null
 * - v1 file (no `version` field) → strips `route_exchanges_to` + `sessions`
 *   map, sets `version: 2`, returns the upgraded object. The file itself
 *   is NOT rewritten here — the next `writeMarker` call upgrades it.
 * - v2 file → returned as-is.
 *
 * Callers always see a v2-conformant `ProjectMarker` regardless of what's
 * on disk. This is the only safe way to evolve the schema without forcing
 * a one-shot migration.
 */
export function readMarker(cwd: string): ProjectMarker | null {
  const p = markerPath(cwd);
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  return normalizeMarker(raw);
}

/**
 * Whitelist for valid project labels in .tim-project. P = Project,
 * L = Learning, E = Error, N = Note — same shape TIM uses everywhere
 * (P0062, L0042, E0031, N0014). A corrupt or out-of-schema label here
 * silently poisons the whole session-binding pipeline (statusline,
 * hooks, load_project), so we reject anything that doesn't match.
 */
const PROJECT_LABEL_PATTERN = /^[PLEN]\d{4}$/;

/**
 * Sentinel label for the Inbox project (P0000). Always treated as
 * valid even when not present in the DB — the Inbox is a system
 * project that tim-store.ensureInboxProject() materializes lazily.
 */
export const INBOX_LABEL = 'P0000';

/**
 * Coerce an unknown JSON value into a v2 ProjectMarker. Strips legacy
 * fields. Returns null if the value isn't a usable marker (missing
 * project/session, wrong types, or malformed project label).
 *
 * NOTE: This is the pure-FS reader. The DB-existence check
 * (project label must resolve to a real entry in the TIM DB) lives
 * in `validateMarkerAgainstStore` — called from the two write-side
 * paths (runSessionStart, syncNearestProjectMarker) before they
 * persist anything. We deliberately keep the disk reader free of
 * DB dependencies so hooks under a tight timeout can still parse
 * the marker without paying for an SQLite roundtrip.
 */
function normalizeMarker(raw: unknown): ProjectMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.project !== 'string' || obj.project.length === 0) return null;
  if (!PROJECT_LABEL_PATTERN.test(obj.project)) {
    console.warn(
      `[tim-hooks] .tim-project has malformed project label "${obj.project}" — ` +
        `expected ^[PLEN]\\d{4}$ (P0062, L0042, …). Ignoring marker.`,
    );
    return null;
  }
  if (typeof obj.session !== 'string') return null;
  if (typeof obj.exchanges !== 'number' || !Number.isFinite(obj.exchanges)) return null;
  if (typeof obj.batch_size !== 'number' || !Number.isFinite(obj.batch_size)) return null;
  if (typeof obj.batches_summarized !== 'number' || !Number.isFinite(obj.batches_summarized)) {
    return null;
  }

  return {
    version: MARKER_VERSION,
    project: obj.project,
    session: obj.session,
    exchanges: obj.exchanges,
    batch_size: obj.batch_size,
    batches_summarized: obj.batches_summarized,
  };
}

/**
 * Defense-in-depth check: a project label that matches the
 * pattern but is semantically bogus (e.g. `P9999` — a label that
 * was never issued by TIM, often the residue of a hand-edit or a
 * botched commit) must NOT be persisted into `.tim-project`. The
 * original P9999 bug bound the statusline to a non-existent
 * project because the file was trusted blindly.
 *
 * Resolution: pattern-match (already enforced by normalizeMarker)
 * AND the project must exist as a `kind=project` entry in the DB.
 * The Inbox (P0000) is exempt — it's a system project that
 * tim-store creates on first use via `ensureInboxProject`.
 *
 * Returns the marker on success, null on rejection. On DB error
 * (store unavailable, DB locked, etc.) we FAIL OPEN: a corrupted
 * DB is not a license to corrupt the marker, but a transient
 * read failure shouldn't brick the session-start hook. The
 * pattern check in normalizeMarker still ran, so we never accept
 * malformed labels — we just skip the existence confirmation.
 */
export async function validateMarkerAgainstStore(
  marker: ProjectMarker,
  store: Pick<TimStore, 'resolveProjectLabel'>,
): Promise<ProjectMarker | null> {
  if (marker.project === INBOX_LABEL) return marker;
  let resolved;
  try {
    resolved = await store.resolveProjectLabel(marker.project);
  } catch (err) {
    console.warn(
      `[tim-hooks] .tim-project validation: DB lookup for "${marker.project}" ` +
        `failed (${(err as Error).message ?? err}) — accepting on pattern match only.`,
    );
    return marker;
  }
  if (resolved.status === 'found') {
    return { ...marker, project: resolved.label };
  }
  console.warn(
    `[tim-hooks] .tim-project has pattern-valid project label "${marker.project}" ` +
      `but no matching entry exists in the DB. Treating as corrupt.`,
  );
  return null;
}

/** Write a project marker file. Always emits the current schema version:
 *  the on-disk file becomes v2 on first write, regardless of the caller's
 *  input. This is the auto-upgrade path for v1 files. */
export function writeMarker(cwd: string, marker: ProjectMarkerInput): void {
  const p = markerPath(cwd);
  const upgraded: ProjectMarker = { ...marker, version: MARKER_VERSION };
  fs.writeFileSync(p, JSON.stringify(upgraded, null, 2));
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
  const { version: _v, ...rest } = located.marker;
  writeMarker(located.dir, {
    ...rest,
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
  const reconciled: ProjectMarkerInput = {
    ...marker,
    exchanges: exchangeCount,
    batches_summarized: batchesSummarized,
  };
  writeMarker(cwd, reconciled);
  // Read back to return the canonical v2 shape (writeMarker upgraded the file).
  return readMarker(cwd) ?? reconciled as ProjectMarker;
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
