import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
export declare const TOOL_DEFS: Array<{
    name: string;
    description: string;
    schema: z.ZodObject<z.ZodRawShape>;
    internal?: boolean;
}>;
export declare function createMcpServer(options?: {
    transportMode?: 'stdio' | 'http';
}): Promise<Server>;
export interface HttpServerHandle {
    app: Express;
    httpServer: HttpServer;
    port: number;
    close: () => Promise<void>;
    activeConnections: () => number;
}
export declare function createHttpServer(options?: {
    host?: string;
    port?: number;
}): Promise<HttpServerHandle>;
export declare function startServer(): Promise<void>;
//# sourceMappingURL=server.d.ts.map