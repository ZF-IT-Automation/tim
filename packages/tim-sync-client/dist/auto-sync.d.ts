import type { TimStore } from 'tim-store';
export declare function autoPush(store: TimStore): Promise<void>;
export declare function autoPull(store: TimStore): Promise<void>;
/** @internal reset cooldowns for tests */
export declare function resetSyncCooldowns(): void;
//# sourceMappingURL=auto-sync.d.ts.map