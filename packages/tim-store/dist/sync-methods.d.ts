import type Database from 'better-sqlite3';
import type { StagingRecord } from 'tim-core';
export interface StagingRow {
    rowid: number;
    key: string;
    entity_type: string;
    operation: string;
    payload: string;
    lww_timestamp: number;
    lww_device: string;
    lww_confidence: number;
    acked: number;
}
export declare function getUnackedStaging(db: Database.Database): StagingRow[];
export declare function ackStaging(db: Database.Database, keys: string[]): void;
export declare function entryLocalLwwTimestamp(row: {
    updated_at?: string;
    created_at: string;
}): number;
export declare function edgeLocalLwwTimestamp(row: {
    updated_at?: string;
}): number;
export declare function recordFromPayload(key: string, entityType: 'entry' | 'edge', operation: 'upsert' | 'delete', payload: string, lwwTimestamp: number, lwwDevice: string, confidence?: number): StagingRecord;
export declare function applyRemoteEntry(db: Database.Database, payloadJson: string, lwwTimestamp: number, lwwDevice: string, deleted: boolean): boolean;
export declare function applyRemoteEdge(db: Database.Database, payloadJson: string, lwwTimestamp: number, lwwDevice: string, deleted: boolean): boolean;
//# sourceMappingURL=sync-methods.d.ts.map