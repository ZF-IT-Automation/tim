import type { TimStore } from 'tim-store';
export declare const MARKER_FILENAME = ".tim-project";
export declare const MARKER_LOCK = ".tim-project.lock";
export interface ProjectMarker {
    project: string;
    session: string;
    exchanges: number;
    batch_size: number;
    batches_summarized: number;
}
export declare function markerPath(cwd: string): string;
export declare function readMarker(cwd: string): ProjectMarker | null;
export declare function writeMarker(cwd: string, marker: ProjectMarker): void;
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
/**
 * Walk up from `startCwd` to the filesystem root and return the NEAREST
 * `.tim-project` (closest ancestor wins). Pure FS — no store, no network —
 * so it is safe to call from a hook under a tight timeout.
 *
 * If the nearest marker FILE exists but is unparseable, we STOP and return
 * null rather than silently binding an ancestor's project.
 */
export declare function findMarker(startCwd: string): MarkerLocation | null;
/**
 * Shared, harness-agnostic directive text. Every start hook (Hermes,
 * Claude Code, Cursor) emits exactly this so wording stays DRY. The TIM
 * marker is authoritative for project binding this turn (see plan §end-state).
 */
export declare function buildLoadDirective(label: string, markerDir: string): string;
//# sourceMappingURL=marker.d.ts.map