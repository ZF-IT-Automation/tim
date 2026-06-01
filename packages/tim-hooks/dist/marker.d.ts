import type { TimStore } from 'tim-store';
export declare const MARKER_FILENAME = ".tim-project";
export declare const MARKER_LOCK = ".tim-project.lock";
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
export declare function markerPath(cwd: string): string;
export declare function readMarker(cwd: string): ProjectMarker | null;
export declare function writeMarker(cwd: string, marker: ProjectMarker): void;
/** Project detection — v1: .tim-project marker only. */
export declare function detectProject(cwd: string): ProjectMarker | null;
/** Re-derive counters from the DB and persist them into the marker. */
export declare function reconcileMarker(store: TimStore, cwd: string): Promise<ProjectMarker>;
export declare const LOCK_TTL_MS: number;
export declare function acquireLock(cwd: string): boolean;
export declare function releaseLock(cwd: string): void;
//# sourceMappingURL=marker.d.ts.map