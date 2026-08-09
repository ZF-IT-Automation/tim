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
/**
 * Mark pushed staging records as acknowledged.
 *
 * Matching is by key *and* timestamp, not by key alone: a local write that
 * lands while the push is in flight stages a newer record for the same key,
 * and that one has to stay unacked so the next cycle picks it up.
 *
 * ponytail: `<=` means two writes to one key inside the same millisecond, one
 * of them mid-push, still ack the newer record. `<` would be worse (the pushed
 * record would never ack at all). Give staging a monotonic sequence if that
 * millisecond ever matters.
 */
export declare function ackStaging(db: Database.Database, acks: Array<{
    key: string;
    lww: number;
}>): void;
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