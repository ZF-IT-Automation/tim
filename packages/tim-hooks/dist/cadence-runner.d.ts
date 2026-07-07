import type { TimStore } from 'tim-store';
export interface CadenceResult {
    exchangeCount: number;
    autoCheckpoint?: boolean;
    checkpointEntryId?: string;
}
/**
 * After logging exchanges: bump marker counter, optionally auto-checkpoint.
 */
export declare function afterExchangeLogged(store: TimStore, sessionId: string, cwd: string): Promise<CadenceResult>;
//# sourceMappingURL=cadence-runner.d.ts.map