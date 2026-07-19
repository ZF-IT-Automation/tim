import type { TimStore } from 'tim-store';
import { type ProjectMarker } from './marker.js';
/**
 * Attempt to recover a real project label when `.tim-project` points at a
 * phantom (pattern-valid label missing from the DB).
 */
export declare function repairPhantomProjectBinding(store: TimStore, dir: string): Promise<string | null>;
/** Strip trailing `?` from statusline unbound display labels. */
export declare function stripUnboundProjectSuffix(label: string): string;
export declare function formatUnboundProjectLabel(label: string): string;
export declare function isUnboundProjectLabel(label: string): boolean;
export declare function markerWithRepairedProject(marker: ProjectMarker, recoveredLabel: string): ProjectMarker;
//# sourceMappingURL=phantom-recovery.d.ts.map