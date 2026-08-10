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
/**
 * Whether a mutating request came from the viewer's own page.
 *
 * Two independent checks, because either one alone has a gap:
 *   - `Origin` is sent on every cross-origin POST, so a mismatch is decisive —
 *     but same-origin fetches may omit it entirely, which is why absence passes.
 *   - `Sec-Fetch-Site` closes that gap in browsers that send it. A request with
 *     no Origin *and* no Sec-Fetch-Site is not from a browser at all (curl, a
 *     test) and is allowed: the viewer is loopback-only, so anything that can
 *     open a socket to it can already read the whole database.
 */
export declare function requireSameOrigin(headers: http.IncomingHttpHeaders, port: number): string | null;
export declare function createViewerServer(data: ViewerData): http.Server;
export declare function startViewer(options: ViewerServerOptions): Promise<ViewerHandle>;
//# sourceMappingURL=viewer-server.d.ts.map