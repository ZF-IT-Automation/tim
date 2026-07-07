import type { TimStore } from 'tim-store';
export interface RebalanceSkip {
    reason: 'locked' | 'single-exchange-batch' | 'unrelated' | 'no-boundary';
    batchIndex?: number;
}
export interface RebalanceResult {
    moved: number;
    skipped: RebalanceSkip[];
}
/**
 * Scan exchange-batch boundaries; move the first exchange of batch N (+ agent reply)
 * into batch N-1 when it is topically related to the last exchange of N-1.
 */
export declare function rebalanceBatch(store: TimStore, sessionId: string, opts?: {
    cwd?: string;
}): Promise<RebalanceResult>;
//# sourceMappingURL=rebalance.d.ts.map