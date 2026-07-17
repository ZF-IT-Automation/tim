import type { TimStore } from 'tim-store';
export declare const MARKER_FILENAME = ".tim-project";
export declare const MARKER_LOCK = ".tim-project.lock";
/**
 * Committed default project label for repos that gitignore `.tim-project`.
 * Contains only the stable `project` field; runtime counters live in the
 * local `.tim-project` file created on session start. Override per-machine
 * by creating `.tim-project` in the repo root (it wins over tim.json).
 */
export declare const CANONICAL_PROJECT_FILENAME = "tim.json";
/**
 * Current marker schema version. Bump this when the on-disk shape changes;
 * readers detect older files by the missing/unknown `version` field and
 * normalize to the current shape.
 */
export declare const MARKER_VERSION = 2;
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
export declare function markerPath(cwd: string): string;
export declare function canonicalProjectPath(cwd: string): string;
export declare function validateProjectLabel(label: string): boolean;
/**
 * Sentinel label for the Inbox project (P0000). Always treated as
 * valid even when not present in the DB — the Inbox is a system
 * project that tim-store.ensureInboxProject() materializes lazily.
 */
export declare const INBOX_LABEL = "P0000";
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
export declare function readMarker(cwd: string): ProjectMarker | null;
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
export declare function validateMarkerAgainstStore(marker: ProjectMarker, store: Pick<TimStore, 'resolveProjectLabel'>): Promise<ProjectMarker | null>;
/**
 * Shared/system directories where a `.tim-project` must never live: every
 * process can have them as cwd, so a marker there leaks into unrelated
 * sessions via walk-up (observed: a cron with cwd=/tmp wrote /tmp/.tim-project
 * and every process under /tmp inherited it). v1 unsafe set — deliberately
 * minimal and explicit: os.tmpdir() itself and the filesystem root.
 * Subdirectories of tmpdir (mkdtemp scratch dirs) are private and stay legal.
 */
export declare function isUnsafeMarkerDir(dir: string): boolean;
/** Atomically write JSON to `filePath` (tmp + rename — no torn reads on POSIX). */
export declare function writeMarkerAtomic(filePath: string, content: string): void;
export declare class ExclusiveMarkerConflictError extends Error {
    readonly filePath: string;
    constructor(filePath: string);
}
/** Publish a marker only when no local marker exists already. */
export declare function writeMarkerExclusive(cwd: string, marker: ProjectMarkerInput): ProjectMarker;
/** Write a project marker file. Always emits the current schema version:
 *  the on-disk file becomes v2 on first write, regardless of the caller's
 *  input. This is the auto-upgrade path for v1 files. */
export declare function writeMarker(cwd: string, marker: ProjectMarkerInput): void;
/**
 * Rotate the session id in cwd's `.tim-project` when the harness supplies a new one.
 * Used by tim-session-start.sh — must not interpolate paths into JS source.
 */
export declare function rotateMarkerSession(cwd: string, sessionId: string): void;
/**
 * Update the nearest `.tim-project` (walk-up from cwd) after tim_load_project.
 * Statusline and hooks read this marker — must match the loaded project label.
 */
export declare function syncNearestProjectMarker(startCwd: string, projectLabel: string, options?: {
    sessionId?: string;
    findOptions?: FindMarkerOptions;
}): boolean;
/** Project detection — cwd-only marker (no walk-up). */
export declare function detectProject(cwd: string): ProjectMarker | null;
/** Re-derive counters from the DB and persist them into the marker. */
export declare function reconcileMarker(store: TimStore, cwd: string): Promise<ProjectMarker>;
export { LOCK_TTL_MS } from './constants.js';
export declare function acquireLock(cwd: string): boolean;
/** True when an active (non-stale) summarizer/session lock is held. */
export declare function isSessionLocked(cwd: string): boolean;
export declare function releaseLock(cwd: string): void;
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
export declare const DEFAULT_MARKER_DISCOVERY_POLICY: MarkerDiscoveryPolicy;
/** Cwd-only binding (session-start hook, checkpoint auto-load). */
export declare const CWD_ONLY_MARKER_DISCOVERY_POLICY: MarkerDiscoveryPolicy;
/** Test helper: env vars override findMarker scope for spawned CLI. */
export declare function findMarkerOptionsFromEnv(): FindMarkerOptions | undefined;
/**
 * Find a project marker from `startCwd` — the single discovery implementation.
 *
 * Policy defaults (when fields omitted): walkUp=true, allowHome=true.
 * Pass `CWD_ONLY_MARKER_DISCOVERY_POLICY` for harness cwd binding.
 */
export declare function discoverMarker(startCwd: string, policy?: MarkerDiscoveryPolicy): MarkerLocation | null;
/**
 * Back-compat wrapper: when `options` is omitted, cwd-only (historical default).
 * Prefer `discoverMarker` with an explicit policy for new code.
 */
export declare function findMarker(startCwd: string, options?: FindMarkerOptions): MarkerLocation | null;
/**
 * Shared, harness-agnostic directive text. Every start hook (Hermes,
 * Claude Code, Cursor) emits exactly this so wording stays DRY. The TIM
 * marker is authoritative for project binding this turn (see plan §end-state).
 */
export declare function buildLoadDirective(projectLabel: string, markerDir: string, bindingLabel?: string): string;
/** Directive when project comes from TIM session metadata (no local .tim-project). */
export declare function buildSessionDirective(projectLabel: string, cwd: string, bindingLabel?: string): string;
//# sourceMappingURL=marker.d.ts.map