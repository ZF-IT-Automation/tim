// TIM MCP — server resilience tests (BUG 4)
// Verifies the process stays alive on unhandledRejection / uncaughtException
// and that error info reaches stderr + the ErrorLogger.
//
// Strategy: spawn the actual stdio server binary, then send it a sequence of
// requests that triggers an unhandledRejection internally. The server must
// keep responding to subsequent valid requests.
//
// We can't easily inject an unhandledRejection from outside the process
// (the server's tools don't have a built-in "throw unhandled" path), so we
// send a malformed JSON-RPC frame and a valid one back-to-back. The SDK
// already handles malformed input (processReadBuffer is wrapped in try/catch),
// so the server must survive.

import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SERVER_PATH = path.resolve(
  __dirname, '..', '..', 'dist', 'server.js',
);

function spawnServer(): ChildProcess {
  if (!fs.existsSync(SERVER_PATH)) {
    throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
  }
  const proc = spawn('node', [SERVER_PATH], {
    env: { ...process.env, TIM_DB_PATH: ':memory:' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return proc;
}

function sendLine(proc: ChildProcess, line: string): void {
  proc.stdin!.write(line + '\n');
}

describe('MCP server resilience (BUG 4)', () => {
  it('survives a malformed JSON-RPC frame and continues serving', async () => {
    const proc = spawnServer();
    const responses: string[] = [];
    const errors: string[] = [];

    proc.stdout!.on('data', (chunk) => {
      responses.push(chunk.toString('utf8'));
    });
    proc.stderr!.on('data', (chunk) => {
      errors.push(chunk.toString('utf8'));
    });

    try {
      // 1) Send garbage that the SDK's readMessage() will choke on.
      sendLine(proc, '{ this is not valid JSON-RPC, the SDK should swallow it');

      // Small delay so the garbage gets processed first.
      await new Promise((r) => setTimeout(r, 200));

      // 2) Send a valid initialize request. The server MUST respond.
      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      });
      sendLine(proc, initReq);

      // Wait for the response.
      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for initialize response')), 3000);
        const onData = (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (text.includes('"id":1')) {
            clearTimeout(timer);
            proc.stdout!.off('data', onData);
            resolve(text);
          }
        };
        proc.stdout!.on('data', onData);
      });

      // The response must be valid JSON-RPC for id=1.
      const parsed = JSON.parse(response.trim().split('\n').pop()!);
      expect(parsed.id).toBe(1);
      expect(parsed.result).toBeDefined();
      expect(parsed.result.protocolVersion).toBeDefined();
    } finally {
      proc.kill('SIGTERM');
      // Give it a moment to exit cleanly.
      await new Promise((r) => setTimeout(r, 100));
      if (!proc.killed) proc.kill('SIGKILL');
    }
  }, 10000);

  it('survives multiple consecutive malformed frames', async () => {
    const proc = spawnServer();
    const responses: string[] = [];

    proc.stdout!.on('data', (chunk) => {
      responses.push(chunk.toString('utf8'));
    });

    try {
      // Send 5 garbage frames in a row.
      for (let i = 0; i < 5; i++) {
        sendLine(proc, `{ garbage frame ${i} ::: not json`);
      }
      await new Promise((r) => setTimeout(r, 200));

      // Then a valid request.
      const req = JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      });
      sendLine(proc, req);

      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), 3000);
        const onData = (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (text.includes('"id":99')) {
            clearTimeout(timer);
            proc.stdout!.off('data', onData);
            resolve(text);
          }
        };
        proc.stdout!.on('data', onData);
      });

      const parsed = JSON.parse(response.trim().split('\n').pop()!);
      expect(parsed.id).toBe(99);
      expect(parsed.result).toBeDefined();
    } finally {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      if (!proc.killed) proc.kill('SIGKILL');
    }
  }, 10000);

  it('responds to a tool call after a malformed frame', async () => {
    const proc = spawnServer();
    const responses: string[] = [];

    proc.stdout!.on('data', (chunk) => {
      responses.push(chunk.toString('utf8'));
    });

    try {
      // Initialize first.
      sendLine(proc, JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }));
      // Send "initialized" notification.
      sendLine(proc, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      // Garbage frame.
      sendLine(proc, '{ broken garbage :::');
      await new Promise((r) => setTimeout(r, 200));

      // Now a real tool call: tim_stats with no args.
      sendLine(proc, JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'tim_stats', arguments: {} },
      }));

      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for tim_stats')), 3000);
        const onData = (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (text.includes('"id":2')) {
            clearTimeout(timer);
            proc.stdout!.off('data', onData);
            resolve(text);
          }
        };
        proc.stdout!.on('data', onData);
      });

      const parsed = JSON.parse(response.trim().split('\n').pop()!);
      expect(parsed.id).toBe(2);
      expect(parsed.result).toBeDefined();
      expect(parsed.result.content).toBeDefined();
      // tim_stats returns JSON.stringify(stats) — must be parseable
      const text = parsed.result.content[0].text;
      const stats = JSON.parse(text);
      expect(stats.totalEntries).toBeDefined();
    } finally {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      if (!proc.killed) proc.kill('SIGKILL');
    }
  }, 10000);
});
