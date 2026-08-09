#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
export interface ToolInputSchema {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
}
/**
 * A tool's parameters as JSON Schema. Shared by the ListTools handler and by
 * `tim viewer`, which builds its parameter forms from the same output — so a
 * form field can never describe a parameter the server would reject.
 */
export declare function toolInputSchema(schema: z.ZodObject<z.ZodRawShape>): ToolInputSchema;
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