import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export declare const KIND_PROJECT_PATH = "project-path";
/** Default staleness threshold for project-path inventory rows (days). */
export declare const DEFAULT_STALE_PATH_MAX_AGE_DAYS = 30;
/** List all project-path inventory rows for a project. */
export declare function listProjectPathRows(store: TimStore, projectId: string): Promise<Entry[]>;
/** Upsert a per-device path observation under the project root. */
export declare function upsertProjectPathRow(store: TimStore, projectId: string, device: string, absPath: string): Promise<Entry>;
/** True when last_seen_at is older than maxAgeDays (default 30). */
export declare function isStalePathRow(row: Entry, now?: number, maxAgeDays?: number): boolean;
//# sourceMappingURL=project-path-inventory.d.ts.map