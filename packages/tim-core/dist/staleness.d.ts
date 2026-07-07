import type { Entry } from './index.js';
export declare function daysSinceLastVerified(entry: Entry, now?: number): number;
export declare function isStale(entry: Entry, thresholdDays: number, now?: number): boolean;
export declare function staleDays(): number;
//# sourceMappingURL=staleness.d.ts.map