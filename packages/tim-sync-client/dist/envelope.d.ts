import type { StagingRecord } from 'tim-core';
export interface TimEnvelope {
    v: 1;
    type: 'entry' | 'edge';
    key: string;
    lww: string;
    deleted: boolean;
    payload: string;
    /** Inner secret-layer encryption applied to entry payload fields. */
    is_encrypted?: boolean;
}
export interface StagingRow {
    key: string;
    entity_type: string;
    operation: string;
    payload: string;
    lww_timestamp: number;
    lww_device: string;
    lww_confidence: number;
    acked: number;
}
export declare function stagingKey(entityType: 'entry' | 'edge', key: string): string;
export declare function parseStagingKey(sk: string): {
    type: 'entry' | 'edge';
    key: string;
};
export declare function stagingToEnvelope(row: StagingRow | StagingRecord): TimEnvelope;
export declare function envelopeToStaging(env: TimEnvelope, deviceId: string): StagingRecord;
export declare function edgeCompositeKey(sourceId: string, targetId: string, type: string): string;
//# sourceMappingURL=envelope.d.ts.map