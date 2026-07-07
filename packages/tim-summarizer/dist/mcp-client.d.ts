import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export interface UnsummarizedExchange {
    seq: number;
    userId: string;
    userContent: string;
    agentId: string | null;
    agentContent: string | null;
}
export interface UnsummarizedBatch {
    sessionId: string;
    summaryNodeId: string;
    exchangesNodeId: string;
    batchIndex: number;
    batchSize: number;
    exchanges: UnsummarizedExchange[];
    hasMore: boolean;
    previousSummaries: string[];
    sessionMeta: Record<string, string | undefined>;
}
export declare function createTimMcpTransport(): StdioClientTransport;
export declare function connectTimMcp(): Promise<Client>;
export declare function callTimTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T>;
//# sourceMappingURL=mcp-client.d.ts.map