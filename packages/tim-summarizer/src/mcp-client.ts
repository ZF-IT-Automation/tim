import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from 'tim-core';
import * as os from 'os';
import * as path from 'path';

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

function dbPathFromEnv(): string {
  if (process.env.TIM_DB_PATH) return process.env.TIM_DB_PATH;
  const config = loadConfig();
  return config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

export function createTimMcpTransport(): StdioClientTransport {
  const serverPath = process.env.TIM_MCP_PATH
    || path.resolve(__dirname, '..', '..', 'tim-mcp', 'dist', 'server.js');
  return new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...process.env, TIM_DB_PATH: dbPathFromEnv() },
  });
}

export async function connectTimMcp(): Promise<Client> {
  const transport = createTimMcpTransport();
  const client = new Client({ name: 'tim-summarizer', version: '0.1.0-alpha' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function parseToolJson<T>(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): T {
  const text = result.content?.find(c => c.type === 'text')?.text ?? '';
  if (result.isError) {
    throw new Error(text || 'MCP tool error');
  }
  return JSON.parse(text) as T;
}

export async function callTimTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  return parseToolJson<T>(result as { content?: Array<{ type: string; text?: string }>; isError?: boolean });
}
