import type { TimStore } from 'tim-store';
/** @internal peek at cooldown timestamp for tests (0 = not armed) */
export declare function _peekCooldown(key: string): number;
export interface AutoPushResult {
    ran: boolean;
    pushed?: number;
    queued?: boolean;
    reason?: string;
}
export declare function autoPush(store: TimStore): Promise<AutoPushResult>;
export interface AutoPullResult {
    ran: boolean;
    pulled?: number;
    conflicts?: number;
    reason?: string;
}
export declare function autoPull(store: TimStore): Promise<AutoPullResult>;
/** @internal reset cooldowns for tests */
export declare function resetSyncCooldowns(): void;
//# sourceMappingURL=auto-sync.d.ts.map