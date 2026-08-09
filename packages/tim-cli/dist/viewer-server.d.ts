import http from 'node:http';
import { ViewerData } from './viewer-data.js';
/** Hosts that resolve to the loopback interface. Nothing else may bind. */
export declare const LOOPBACK_HOSTS: ReadonlySet<string>;
export declare class NonLoopbackBindError extends Error {
    readonly host: string;
    constructor(host: string);
}
export declare function assertLoopbackHost(host: string): void;
export interface ViewerServerOptions {
    dbPath: string;
    port?: number;
    host?: string;
    showSecrets?: boolean;
}
export interface ViewerHandle {
    server: http.Server;
    data: ViewerData;
    port: number;
    host: string;
    url: string;
    close: () => Promise<void>;
}
export declare function createViewerServer(data: ViewerData): http.Server;
export declare function startViewer(options: ViewerServerOptions): Promise<ViewerHandle>;
//# sourceMappingURL=viewer-server.d.ts.map