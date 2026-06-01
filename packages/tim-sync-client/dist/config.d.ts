export interface SyncConfig {
    serverUrl: string;
    userId: string;
    token: string;
    salt: string;
    fileId: string;
}
export interface SyncState {
    fileId: string;
    cursor: string | null;
    lastPush: string | null;
    lastPull: string | null;
}
export declare function getSyncConfigPath(): string;
export declare function getSyncStatePath(): string;
export declare function getDeviceIdPath(): string;
export declare function getQueuePath(fileId: string): string;
export declare function loadConfig(): SyncConfig | null;
export declare function saveConfig(config: SyncConfig): void;
export declare function loadSyncState(): SyncState | null;
export declare function saveSyncState(state: SyncState): void;
export declare function getDeviceId(): string;
export declare function defaultFileId(deviceId?: string): string;
//# sourceMappingURL=config.d.ts.map