import http from 'node:http';
import { TenantRegistry } from './tenant-registry.js';
export interface HostedServerOptions {
    port?: number;
    dataDir: string;
}
export interface HostedServerHandle {
    server: http.Server;
    registry: TenantRegistry;
    port: number;
    startedAt: number;
    close: () => Promise<void>;
}
export declare function createHostedSyncServer(options: HostedServerOptions): HostedServerHandle;
export declare function startHostedSyncServer(options: HostedServerOptions): Promise<HostedServerHandle>;
//# sourceMappingURL=server.d.ts.map