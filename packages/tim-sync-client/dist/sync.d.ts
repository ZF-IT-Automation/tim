import type { TimStore } from 'tim-store';
import { TimSyncClient } from './client.js';
import { type SyncState } from './config.js';
export type { SyncState } from './config.js';
export interface SyncCycleContext {
    client: TimSyncClient;
    store: TimStore;
    state: SyncState;
    deviceId: string;
    passphrase: string;
    salt: string;
}
export declare function pushCycle(client: TimSyncClient, store: TimStore, state: SyncState, deviceId: string, encryptFn: (data: string) => string): Promise<{
    pushed: number;
    queued: boolean;
}>;
export declare function pullCycle(client: TimSyncClient, store: TimStore, state: SyncState, decryptFn: (data: string) => string): Promise<{
    pulled: number;
    conflicts: number;
}>;
export declare function runPush(ctx: SyncCycleContext): Promise<{
    pushed: number;
    queued: boolean;
}>;
export declare function runPull(ctx: SyncCycleContext): Promise<{
    pulled: number;
    conflicts: number;
}>;
export declare function buildSyncContext(store: TimStore, config: {
    serverUrl: string;
    token: string;
    salt: string;
    fileId: string;
}, passphrase: string, deviceId: string): SyncCycleContext;
//# sourceMappingURL=sync.d.ts.map