import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export declare const HUMAN_ROOT_LABEL = "H0000";
export declare const HUMAN_SECTIONS: readonly ["Identity", "Skills", "Preferences", "Context"];
export interface HumanProfileNode {
    root: Entry;
    sections: Entry[];
}
/** Ensure human profile root (H0000) and standard sections exist. */
export declare function ensureHumanProfile(store: TimStore): Promise<HumanProfileNode>;
export declare function getHumanProfileSummary(store: TimStore): Promise<string>;
//# sourceMappingURL=user.d.ts.map