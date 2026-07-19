import type { TimStore } from 'tim-store';
export declare const MARKER_FILENAME = ".tim-project";
export { SUMMARIZER_LOCK, MARKER_LOCK } from './constants.js';
/**
 * Committed default project label for repos that gitignore `.tim-project`.
 * Contains only the stable `project` field. Override per-machine by creating
 * `.tim-project` in the repo root (it wins over tim.json).
 */
export declare const CANONICAL_PROJECT_FILENAME = "tim.json";
/**
 * Current marker schema version. Bump this when the on-disk shape changes;
 * readers detect older files by the missing/unknown `version` field and
 * normalize to the current shape.
 */
export declare const MARKER_VERSION = 3;
/**
 * .tim-project — v3 schema (label-only binding).
 *
 * Runtime session id and counters live in the TIM store. v1/v2 files are read
 * as v3 by ignoring their extra fields; the next legitimate write upgrades
 * on-disk content to the two-field shape.
 */
export interface ProjectMarker {
    version: 3;
    project: string;
}
/**
 * Input shape for writeMarker. Callers MAY omit `version` — the writer
 * always stamps the current version on disk.
 */
export type ProjectMarkerInput = {
    project: string;
    version?: 3;
};
export declare function markerPath(cwd: string): string;
export declare function canonicalProjectPath(cwd: string): string;
export declare function summarizerLockPath(cwd: string): string;
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
 * - v1/v2 file → `{ version: 3, project }` (runtime fields ignored)
 * - v3 file → returned as-is
 *
 * When no `.tim-project` exists, falls back to `tim.json` (committed
 * canonical default). A real `.tim-project` always wins — even when
 * corrupt (returns null rather than silently using tim.json).
 */
export declare function readMarker(cwd: string): ProjectMarker | null;
/**
 * Defense-in-depth check: a project label that matches the
 * pattern but is semantically bogus (e.g. `P9999`) must NOT be persisted.
 */
export declare function validateMarkerAgainstStore(marker: ProjectMarker, store: Pick<TimStore, 'resolveProjectLabel'>): Promise<ProjectMarker | null>;
/**
 * Shared/system directories where a `.tim-project` must never live.
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
/** Write a project marker file. Always emits the current v3 schema. */
export declare function writeMarker(cwd: string, marker: ProjectMarkerInput): void;
/**
 * Update the nearest `.tim-project` (walk-up from cwd) after tim_load_project.
 */
export declare function syncNearestProjectMarker(startCwd: string, projectLabel: string, options?: {
    findOptions?: FindMarkerOptions;
}): boolean;
/** Project detection — cwd-only marker (no walk-up). */
export declare function detectProject(cwd: string): ProjectMarker | null;
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
 */
export declare function discoverMarker(startCwd: string, policy?: MarkerDiscoveryPolicy): MarkerLocation | null;
/**
 * Back-compat wrapper: when `options` is omitted, cwd-only (historical default).
 */
export declare function findMarker(startCwd: string, options?: FindMarkerOptions): MarkerLocation | null;
/**
 * Shared, harness-agnostic directive text. Every start hook emits exactly this.
 */
export declare function buildLoadDirective(projectLabel: string, markerDir: string, bindingLabel?: string): string;
/** Directive when project comes from TIM session metadata (no local .tim-project). */
export declare function buildSessionDirective(projectLabel: string, cwd: string, bindingLabel?: string): string;
//# sourceMappingURL=marker.d.ts.map