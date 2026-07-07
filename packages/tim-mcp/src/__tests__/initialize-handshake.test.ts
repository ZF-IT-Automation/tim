import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

async function waitForJsonRpcId(proc: ChildProcess, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { id?: number };
          if (parsed.id === id) {
            clearTimeout(timer);
            proc.stdout!.off('data', onData);
            resolve(parsed);
          }
        } catch { /* skip */ }
      }
    };
    proc.stdout!.on('data', onData);
  });
}

describe('MCP initialize handshake', () => {
  it('negotiates supported protocol version via SDK handler', async () => {
    const proc = spawn('node', [SERVER_PATH], {
      env: { ...process.env, TIM_DB_PATH: ':memory:' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      proc.stdin!.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      })}\n`);
      const response = await waitForJsonRpcId(proc, 1);
      const result = response.result as { protocolVersion: string; capabilities: Record<string, unknown> };
      expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(result.protocolVersion);
      expect(result.capabilities.tools).toBeDefined();
    } finally {
      proc.kill('SIGTERM');
    }
  }, 10000);
});
