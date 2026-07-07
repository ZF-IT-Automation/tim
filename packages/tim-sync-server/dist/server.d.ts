import http from 'node:http';
import { TenantRegistry } from './tenant-registry.js';
export declare const MAX_BODY_BYTES: number;
export declare const REGISTER_RATE_LIMIT = 5;
export declare const REGISTER_RATE_WINDOW_MS: number;
export interface HostedServerOptions {
    port?: number;
    dataDir: string;
    adminToken?: string;
}
export interface HostedServerHandle {
    server: http.Server;
    registry: TenantRegistry;
    port: number;
    startedAt: number;
    close: () => Promise<void>;
}
export declare class BodyTooLargeError extends Error {
    constructor();
}
export declare function readBody(req: http.IncomingMessage, maxBytes?: number): Promise<string>;
export declare class RegisterRateLimiter {
    private attempts;
    isLimited(ip: string, now?: number): boolean;
    reset(): void;
}
export declare function createHostedSyncServer(options: HostedServerOptions, rateLimiter?: RegisterRateLimiter): HostedServerHandle;
export declare function startHostedSyncServer(options: HostedServerOptions): Promise<HostedServerHandle>;
//# sourceMappingURL=server.d.ts.map