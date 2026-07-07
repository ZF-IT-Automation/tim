import { type Entry } from 'tim-core';
export interface StaleInfo {
    lastVerified: string;
    daysSince: number;
}
export type TrustAnnotated = Entry & {
    stale?: StaleInfo;
    provenance_drift?: {
        commitsSince: number;
    };
};
export declare function annotateTrust(entry: Entry, cwd: string): TrustAnnotated;
//# sourceMappingURL=trust.d.ts.map