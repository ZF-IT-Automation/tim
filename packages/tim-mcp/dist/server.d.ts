import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
export declare function createMcpServer(): Promise<Server>;
export interface HttpServerHandle {
    app: Express;
    httpServer: HttpServer;
    port: number;
    close: () => Promise<void>;
}
export declare function createHttpServer(options?: {
    host?: string;
    port?: number;
}): Promise<HttpServerHandle>;
export declare function startServer(): Promise<void>;
//# sourceMappingURL=server.d.ts.map