import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { LOCK_TTL_MS } from './constants.js';
import type { TimStore } from 'tim-store';
import { deriveCounters } from 'tim-store';

export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';

/**
 * Committed default project label for repos that gitignore `.tim-project`.
 * Contains only the stable `project` field; runtime counters live in the
 * local `.tim-project` file created on session start. Override per-machine
 * by creating `.tim-project` in the repo root (it wins over tim.json).
 */
export const CANONICAL_PROJECT_FILENAME = 'tim.json';

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

export function canonicalProjectPath(cwd: string): string {
  return path.join(cwd, CANONICAL_PROJECT_FILENAME);
}

/** Valid project labels: P/L/E/N + 4 digits (P0062, L0042, …). */
const PROJECT_LABEL_PATTERN = /^[PLEN]\d{4}$/;

/**
 * Shape-valid label that must never be written to `.tim-project`.
 * Used as a vitest fixture / corruption sentinel (see P9999 bug); DB
 * validation also rejects it when the project does not exist.
 */
const DENIED_MARKER_LABELS = new Set(['P9999']);

export function validateProjectLabel(label: string): boolean {
  if (DENIED_MARKER_LABELS.has(label)) return false;
  return PROJECT_LABEL_PATTERN.test(label);
}

/**
 * Sentinel label for the Inbox project (P0000). Always treated as
 * valid even when not present in the DB — the Inbox is a system
 * project that tim-store.ensureInboxProject() materializes lazily.
 */
export const INBOX_LABEL = 'P0000';

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
 *
 * When no `.tim-project` exists, falls back to `tim.json` (committed
 * canonical default). A real `.tim-project` always wins — even when
 * corrupt (returns null rather than silently using tim.json).
 */
export function readMarker(cwd: string): ProjectMarker | null {
  const p = markerPath(cwd);
  if (fs.existsSync(p)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
    return normalizeMarker(raw);
  }
  return readCanonicalProject(cwd);
}

/**
 * Read the committed default project from tim.json. Runtime fields use
 * neutral defaults — session start overwrites them into `.tim-project`.
 */
function readCanonicalProject(cwd: string): ProjectMarker | null {
  const p = canonicalProjectPath(cwd);
  if (!fs.existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.project !== 'string' || !PROJECT_LABEL_PATTERN.test(obj.project)) {
    console.warn(
      `[tim-hooks] ${CANONICAL_PROJECT_FILENAME} has malformed project label ` +
        `"${String(obj.project)}" — expected ^[PLEN]\\d{4}$. Ignoring.`,
    );
    return null;
  }
  return {
    version: MARKER_VERSION,
    project: obj.project,
    session: '',
    exchanges: 0,
    batch_size: 5,
    batches_summarized: 0,
  };
}

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

/** Atomically write JSON to `filePath` (tmp + rename — no torn reads on POSIX). */
export function writeMarkerAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

export class ExclusiveMarkerConflictError extends Error {
  constructor(public readonly filePath: string) {
    super(`Local marker already exists: ${filePath}`);
    this.name = 'ExclusiveMarkerConflictError';
  }
}

/** Publish a marker only when no local marker exists already. */
export function writeMarkerExclusive(cwd: string, marker: ProjectMarkerInput): ProjectMarker {
  if (!validateProjectLabel(marker.project)) {
    throw new Error(
      `[tim-hooks] writeMarkerExclusive: refusing to write invalid project label "${marker.project}" — ` +
        `expected ^[PLEN]\\d{4}$ (P0062, L0042, …). Marker not written.`,
    );
  }

  const filePath = markerPath(cwd);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const complete: ProjectMarker = { ...marker, version: MARKER_VERSION };

  try {
    fs.writeFileSync(tmp, JSON.stringify(complete, null, 2), { flag: 'wx' });
    try {
      fs.linkSync(tmp, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ExclusiveMarkerConflictError(filePath);
      }
      throw err;
    }
    return complete;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Write a project marker file. Always emits the current schema version:
 *  the on-disk file becomes v2 on first write, regardless of the caller's
 *  input. This is the auto-upgrade path for v1 files. */
export function writeMarker(cwd: string, marker: ProjectMarkerInput): void {
  if (!validateProjectLabel(marker.project)) {
    console.warn(
      `[tim-hooks] writeMarker: refusing to write invalid project label "${marker.project}" — ` +
        `expected ^[PLEN]\\d{4}$ (P0062, L0042, …). Marker not written.`,
    );
    return;
  }
  const p = markerPath(cwd);
  const upgraded: ProjectMarker = { ...marker, version: MARKER_VERSION };
  writeMarkerAtomic(p, JSON.stringify(upgraded, null, 2));
}

/**
 * Rotate the session id in cwd's `.tim-project` when the harness supplies a new one.
 * Used by tim-session-start.sh — must not interpolate paths into JS source.
 */
export function rotateMarkerSession(cwd: string, sessionId: string): void {
  const p = markerPath(cwd);
  if (!fs.existsSync(p)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (raw.session === sessionId) return;
    raw.session = sessionId;
    writeMarkerAtomic(p, JSON.stringify(raw, null, 2));
  } catch {
    /* corrupt marker — leave untouched */
  }
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
  if (!validateProjectLabel(projectLabel)) {
    console.warn(
      `[tim-hooks] syncNearestProjectMarker: refusing to sync invalid project label ` +
        `"${projectLabel}" — expected ^[PLEN]\\d{4}$. Returning false.`,
    );
    return false;
  }
  const located = discoverMarker(startCwd, {
    ...DEFAULT_MARKER_DISCOVERY_POLICY,
    ...options?.findOptions,
  });
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

/** Project detection — cwd-only marker (no walk-up). */
export function detectProject(cwd: string): ProjectMarker | null {
  return discoverMarker(cwd, CWD_ONLY_MARKER_DISCOVERY_POLICY)?.marker ?? null;
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

export { LOCK_TTL_MS } from './constants.js';

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

/** Discovery policy for `discoverMarker` — single knob for walk-up scope. */
export type MarkerDiscoveryPolicy = FindMarkerOptions;

export interface FindMarkerOptions {
  /** Do not walk above this directory (isolates tests; ignores e.g. /tmp/.tim-project). */
  maxRoot?: string;
  /** Walk parent directories for a marker. */
  walkUp?: boolean;
  /** When walkUp is true, include ancestor markers at $HOME. Default false. */
  allowHome?: boolean;
}

/** Production default: walk-up from cwd, home ancestors allowed (statusline / sync paths). */
export const DEFAULT_MARKER_DISCOVERY_POLICY: MarkerDiscoveryPolicy = {
  walkUp: true,
  allowHome: true,
};

/** Cwd-only binding (session-start hook, checkpoint auto-load). */
export const CWD_ONLY_MARKER_DISCOVERY_POLICY: MarkerDiscoveryPolicy = {
  walkUp: false,
  allowHome: false,
};

function isInsideRoot(dir: string, root: string): boolean {
  const d = path.resolve(dir);
  const r = path.resolve(root);
  return d === r || d.startsWith(r + path.sep);
}

/** Test helper: env vars override findMarker scope for spawned CLI. */
export function findMarkerOptionsFromEnv(): FindMarkerOptions | undefined {
  const maxRoot = process.env.TIM_MARKER_MAX_ROOT?.trim();
  const walkUp = process.env.TIM_MARKER_WALK_UP === '1';
  const allowHome = process.env.TIM_MARKER_ALLOW_HOME === '1';
  if (!maxRoot && !walkUp && !allowHome) return undefined;
  return {
    ...(maxRoot ? { maxRoot } : {}),
    ...(walkUp ? { walkUp: true } : {}),
    ...(allowHome ? { allowHome: true } : {}),
  };
}

function isHomePath(dir: string): boolean {
  return path.resolve(dir) === path.resolve(os.homedir());
}

function pickMarkerLocation(candidates: MarkerLocation[]): MarkerLocation {
  return candidates.reduce((best, cur) =>
    path.resolve(cur.dir).length > path.resolve(best.dir).length ? cur : best,
  );
}

type ScanResult = MarkerLocation | null | 'corrupt';

function scanDirForMarker(dir: string): ScanResult {
  if (fs.existsSync(markerPath(dir))) {
    const marker = readMarker(dir);
    if (!marker) return 'corrupt';
    return { marker, dir };
  }
  const canonical = readCanonicalProject(dir);
  if (canonical) return { marker: canonical, dir };
  return null;
}

/**
 * Find a project marker from `startCwd` — the single discovery implementation.
 *
 * Policy defaults (when fields omitted): walkUp=true, allowHome=true.
 * Pass `CWD_ONLY_MARKER_DISCOVERY_POLICY` for harness cwd binding.
 */
export function discoverMarker(
  startCwd: string,
  policy: MarkerDiscoveryPolicy = DEFAULT_MARKER_DISCOVERY_POLICY,
): MarkerLocation | null {
  const walkUp = policy.walkUp ?? true;
  const allowHome = policy.allowHome ?? true;
  const startResolved = path.resolve(startCwd);

  if (!walkUp) {
    const result = scanDirForMarker(startResolved);
    if (result === 'corrupt') return null;
    return result;
  }

  const maxRoot = policy.maxRoot ? path.resolve(policy.maxRoot) : null;
  let dir = startResolved;
  const found: MarkerLocation[] = [];
  for (let i = 0; i < 256; i++) {
    const result = scanDirForMarker(dir);
    if (result === 'corrupt') return null;
    if (result) found.push(result);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (maxRoot && isInsideRoot(dir, maxRoot) && !isInsideRoot(parent, maxRoot)) break;
    dir = parent;
  }
  if (found.length === 0) return null;

  const filtered = found.filter((loc) => {
    if (allowHome) return true;
    if (!isHomePath(loc.dir)) return true;
    return path.resolve(loc.dir) === startResolved;
  });
  if (filtered.length === 0) return null;
  return pickMarkerLocation(filtered);
}

/**
 * Back-compat wrapper: when `options` is omitted, cwd-only (historical default).
 * Prefer `discoverMarker` with an explicit policy for new code.
 */
export function findMarker(startCwd: string, options?: FindMarkerOptions): MarkerLocation | null {
  if (!options) {
    return discoverMarker(startCwd, CWD_ONLY_MARKER_DISCOVERY_POLICY);
  }
  return discoverMarker(startCwd, {
    walkUp: options.walkUp ?? false,
    allowHome: options.allowHome ?? false,
    ...(options.maxRoot ? { maxRoot: options.maxRoot } : {}),
  });
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
