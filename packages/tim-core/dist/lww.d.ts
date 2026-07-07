import type { StagingRecord } from './index.js';
export interface ConflictResolution {
    winner: StagingRecord;
    loser: StagingRecord | null;
    reason: 'newer_timestamp' | 'device_tiebreak' | 'only_one';
}
export declare function resolveLWW(a: StagingRecord, b: StagingRecord): ConflictResolution;
//# sourceMappingURL=lww.d.ts.map