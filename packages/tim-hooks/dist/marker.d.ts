import type { TimStore } from 'tim-store';
export declare const MARKER_FILENAME = ".tim-project";
export declare const MARKER_LOCK = ".tim-project.lock";
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
export declare function readMarker(cwd: string): ProjectMarker | null;
/**
 * Sentinel label for the Inbox project (P0000). Always treated as
 * valid even when not present in the DB — the Inbox is a system
 * project that tim-store.ensureInboxProject() materializes lazily.
 */
export declare const INBOX_LABEL = "P0000";
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
/** Write a project marker file. Always emits the current schema version:
 *  the on-disk file becomes v2 on first write, regardless of the caller's
 *  input. This is the auto-upgrade path for v1 files. */
export declare function writeMarker(cwd: string, marker: ProjectMarkerInput): void;
/**
 * Update the nearest `.tim-project` (walk-up from cwd) after tim_load_project.
 * Statusline and hooks read this marker — must match the loaded project label.
 */
export declare function syncNearestProjectMarker(startCwd: string, projectLabel: string, options?: {
    sessionId?: string;
    findOptions?: FindMarkerOptions;
}): boolean;
/** Project detection — v1: .tim-project marker only. */
export declare function detectProject(cwd: string): ProjectMarker | null;
/** Re-derive counters from the DB and persist them into the marker. */
export declare function reconcileMarker(store: TimStore, cwd: string): Promise<ProjectMarker>;
export declare const LOCK_TTL_MS: number;
export declare function acquireLock(cwd: string): boolean;
/** True when an active (non-stale) summarizer/session lock is held. */
export declare function isSessionLocked(cwd: string): boolean;
export declare function releaseLock(cwd: string): void;
export interface MarkerLocation {
    marker: ProjectMarker;
    dir: string;
}
export interface FindMarkerOptions {
    /** Do not walk above this directory (isolates tests; ignores e.g. /tmp/.tim-project). */
    maxRoot?: string;
}
/** Test helper: TIM_MARKER_MAX_ROOT limits walk-up scope for spawned CLI. */
export declare function findMarkerOptionsFromEnv(): FindMarkerOptions | undefined;
/**
 * Walk up from `startCwd` and return the deepest `.tim-project` on that chain.
 * When both a repo marker and `~/.tim-project` exist, the home marker is skipped.
 * Pure FS — no store, no network — safe for hooks under a tight timeout.
 *
 * If a marker FILE exists but is unparseable, we STOP and return null rather than
 * silently binding an ancestor's project.
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