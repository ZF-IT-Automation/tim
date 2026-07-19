import type { TimStore } from 'tim-store';
export interface CadenceResult {
    exchangeCount: number;
    autoCheckpoint?: boolean;
    checkpointEntryId?: string;
}
/**
 * After logging exchanges: derive counters from the store, optionally auto-checkpoint.
 */
export declare function afterExchangeLogged(store: TimStore, sessionId: string, _cwd: string): Promise<CadenceResult>;
//# sourceMappingURL=cadence-runner.d.ts.map