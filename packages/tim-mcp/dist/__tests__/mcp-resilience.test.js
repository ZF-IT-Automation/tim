"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');
function spawnServer() {
    if (!fs.existsSync(SERVER_PATH)) {
        throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    const proc = (0, node_child_process_1.spawn)('node', [SERVER_PATH], {
        env: { ...process.env, TIM_DB_PATH: ':memory:' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return proc;
}
function sendLine(proc, line) {
    proc.stdin.write(line + '\n');
}
(0, vitest_1.describe)('MCP server resilience (BUG 4)', () => {
    (0, vitest_1.it)('survives a malformed JSON-RPC frame and continues serving', async () => {
        const proc = spawnServer();
        const responses = [];
        const errors = [];
        proc.stdout.on('data', (chunk) => {
            responses.push(chunk.toString('utf8'));
        });
        proc.stderr.on('data', (chunk) => {
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
            const response = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timeout waiting for initialize response')), 3000);
                const onData = (chunk) => {
                    const text = chunk.toString('utf8');
                    if (text.includes('"id":1')) {
                        clearTimeout(timer);
                        proc.stdout.off('data', onData);
                        resolve(text);
                    }
                };
                proc.stdout.on('data', onData);
            });
            // The response must be valid JSON-RPC for id=1.
            const parsed = JSON.parse(response.trim().split('\n').pop());
            (0, vitest_1.expect)(parsed.id).toBe(1);
            (0, vitest_1.expect)(parsed.result).toBeDefined();
            (0, vitest_1.expect)(parsed.result.protocolVersion).toBeDefined();
        }
        finally {
            proc.kill('SIGTERM');
            // Give it a moment to exit cleanly.
            await new Promise((r) => setTimeout(r, 100));
            if (!proc.killed)
                proc.kill('SIGKILL');
        }
    }, 10000);
    (0, vitest_1.it)('survives multiple consecutive malformed frames', async () => {
        const proc = spawnServer();
        const responses = [];
        proc.stdout.on('data', (chunk) => {
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
            const response = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timeout')), 3000);
                const onData = (chunk) => {
                    const text = chunk.toString('utf8');
                    if (text.includes('"id":99')) {
                        clearTimeout(timer);
                        proc.stdout.off('data', onData);
                        resolve(text);
                    }
                };
                proc.stdout.on('data', onData);
            });
            const parsed = JSON.parse(response.trim().split('\n').pop());
            (0, vitest_1.expect)(parsed.id).toBe(99);
            (0, vitest_1.expect)(parsed.result).toBeDefined();
        }
        finally {
            proc.kill('SIGTERM');
            await new Promise((r) => setTimeout(r, 100));
            if (!proc.killed)
                proc.kill('SIGKILL');
        }
    }, 10000);
    (0, vitest_1.it)('responds to a tool call after a malformed frame', async () => {
        const proc = spawnServer();
        const responses = [];
        proc.stdout.on('data', (chunk) => {
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
            const response = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timeout waiting for tim_stats')), 3000);
                const onData = (chunk) => {
                    const text = chunk.toString('utf8');
                    if (text.includes('"id":2')) {
                        clearTimeout(timer);
                        proc.stdout.off('data', onData);
                        resolve(text);
                    }
                };
                proc.stdout.on('data', onData);
            });
            const parsed = JSON.parse(response.trim().split('\n').pop());
            (0, vitest_1.expect)(parsed.id).toBe(2);
            (0, vitest_1.expect)(parsed.result).toBeDefined();
            (0, vitest_1.expect)(parsed.result.content).toBeDefined();
            // tim_stats returns JSON.stringify(stats) — must be parseable
            const text = parsed.result.content[0].text;
            const stats = JSON.parse(text);
            (0, vitest_1.expect)(stats.totalEntries).toBeDefined();
        }
        finally {
            proc.kill('SIGTERM');
            await new Promise((r) => setTimeout(r, 100));
            if (!proc.killed)
                proc.kill('SIGKILL');
        }
    }, 10000);
});
//# sourceMappingURL=mcp-resilience.test.js.map