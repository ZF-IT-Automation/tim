import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
/** Human project name from a P-entry (without P-label prefix when duplicated in title). */
export declare function projectDisplayNameFromEntry(entry: Entry): string;
/** Crop for status bar / narrow UI (default 20 chars, ellipsis included in limit). */
export declare function cropDisplayName(text: string, maxLen?: number): string;
/** Full binding line for directives: `P0062 — bbbee PM Workflow` (uncropped). */
export declare function resolveProjectBindingLabel(store: TimStore, query: string): Promise<string>;
export declare function resolveProjectDisplayName(store: TimStore, query: string, maxLen?: number): Promise<string>;
//# sourceMappingURL=project-display.d.ts.map