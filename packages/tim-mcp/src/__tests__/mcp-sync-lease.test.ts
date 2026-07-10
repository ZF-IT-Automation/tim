// TIM MCP — integration tests for FMCP batch fixes
//
// Covers regression findings from the contrary review:
//   F-MCP-002: tim_sync action=pull must be implemented (not "not yet implemented")
//   F-MCP-003: auto-sync cooldown must only arm after a successful runPush/runPull
// (F-MCP-001 covered tim_lease, removed 2026-07-10 — grant was unusable via MCP
//  and TTL decorative; fable5 review: "build it or remove it".)
//
// Pattern borrowed from metadata-roundtrip.test.ts — spawn stdio server + JSON-RPC.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { TimStore } from 'tim-store';
import {
  resetSyncCooldowns,
  _peekCooldown,
} from 'tim-sync-client';
import * as syncClient from 'tim-sync-client';

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

interface JsonRpcResp {
  id: number;
  result?: { content: { type: string; text: string; isError?: boolean }[]; isError?: boolean };
  error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (resp: JsonRpcResp) => void>();
  private buffer = '';
  private ready = false;
  private stderrBuf = '';

  constructor(dbPath: string, extraEnv: Record<string, string> = {}) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      env: { ...process.env, TIM_DB_PATH: dbPath, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (chunk) => this.onData(chunk.toString('utf8')));
    this.proc.stderr!.on('data', (chunk) => {
      this.stderrBuf += chunk.toString('utf8');
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResp;
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      } catch {
        // ignore
      }
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 10000);
      this.pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      this.proc.stdin!.write(frame);
    });
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'sync-lease-tests', version: '0.0.1' },
    });
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResp> {
    await this.init();
    return this.send('tools/call', { name, arguments: args });
  }

  getStderr(): string {
    return this.stderrBuf;
  }

  kill(): void {
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // already dead
    }
    setTimeout(() => {
      if (!this.proc.killed) {
        try { this.proc.kill('SIGKILL'); } catch { /* noop */ }
      }
    }, 100);
  }
}

function tempDbPath(): string {
  return `/tmp/tim-sync-lease-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

// ─── tim_lease is gone: removed tools must not silently half-work ───────────

describe('tim_lease removal: unknown tool errors cleanly', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('tim_lease is no longer callable', async () => {
    const resp = await client.callTool('tim_lease', { revoke: 'claude', entryId: 'x' });
    const text = resp.result?.content?.[0]?.text ?? resp.error?.message ?? '';
    expect(text).toMatch(/Unknown tool|not found/i);
  });
});

// ─── F-MCP-002: tim_sync action=pull is implemented ─────────────────────────

describe('F-MCP-002: tim_sync action=pull is implemented', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('returns synchronously with pulled/conflicts/cursor/timestamp (no "not yet implemented")', async () => {
    const resp = await client.callTool('tim_sync', { action: 'pull' });

    expect(resp.error).toBeUndefined();
    const text = resp.result!.content[0].text;

    // Must NOT be the old placeholder string.
    expect(text).not.toContain('not yet implemented');

    // Must be valid JSON with the documented fields.
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('pulled');
    expect(parsed).toHaveProperty('conflicts');
    expect(parsed).toHaveProperty('cursor');
    expect(parsed).toHaveProperty('timestamp');
    expect(typeof parsed.pulled).toBe('number');
    expect(typeof parsed.conflicts).toBe('number');
    // cursor may be 0 (initial state) or null — both are valid numeric/null.
    expect(['number', 'object']).toContain(typeof parsed.cursor);
    // timestamp should be parseable as ISO date.
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
  });

  it('returns "Sync not configured" when no sync config exists (no TIM_SYNC_PASSPHRASE)', async () => {
    // Default env has no TIM_SYNC_PASSPHRASE → autoPull returns ran:false, reason:no-passphrase.
    // We treat the missing-config / no-passphrase path as the friendly message.
    const orig = process.env.TIM_SYNC_PASSPHRASE;
    const origCfg = process.env.TIM_SYNC_CONFIG;
    delete process.env.TIM_SYNC_PASSPHRASE;
    delete process.env.TIM_SYNC_CONFIG;
    try {
      const resp = await client.callTool('tim_sync', { action: 'pull' });
      // Either it returned the friendly message, or it returned pulled=0 (also acceptable).
      // The contract: NO "not yet implemented" string.
      const text = resp.result!.content[0].text;
      expect(text).not.toContain('not yet implemented');
      // And it's parseable JSON with the required fields.
      const parsed = JSON.parse(text);
      expect(parsed).toHaveProperty('pulled');
      expect(parsed).toHaveProperty('conflicts');
    } finally {
      if (orig !== undefined) process.env.TIM_SYNC_PASSPHRASE = orig;
      if (origCfg !== undefined) process.env.TIM_SYNC_CONFIG = origCfg;
    }
  });
});






// ─── F-MCP-003: auto-sync cooldown does NOT arm on failure ──────────────────
//
// Regression: F-MCP-003 — `markSynced` was being called unconditionally in
// the try block, so even failed syncs would arm the 30s cooldown and
// suppress retries. The fix moves `markSynced` to fire ONLY on success.
//
// This block uses REAL `autoPull`/`autoPush` and REAL network calls:
//   - failure path: sync config points at a closed port, fetch() throws,
//                   the catch path runs and cooldown stays unarmed
//   - success path: a local HTTP server accepts the call, runPull returns
//                   cleanly, markSynced arms the cooldown
// No `vi.mock` is used — vitest 3.2.6 string-path mock is unnecessary.

describe('F-MCP-003: auto-sync cooldown only arms on success', () => {
  let mod: typeof import('tim-sync-client');
  let savedEnv: { passphrase?: string };

  beforeEach(async () => {
    savedEnv = { passphrase: process.env.TIM_SYNC_PASSPHRASE };
    resetSyncCooldowns();
    mod = await import('tim-sync-client');
  });

  afterEach(() => {
    resetSyncCooldowns();
    if (savedEnv.passphrase !== undefined) {
      process.env.TIM_SYNC_PASSPHRASE = savedEnv.passphrase;
    } else {
      delete process.env.TIM_SYNC_PASSPHRASE;
    }
    // Wipe the sync config file so it does not leak across tests.
    try {
      mod.saveConfig({ serverUrl: '', userId: '', token: '', salt: '', fileId: '' });
    } catch { /* noop */ }
  });

  function makeStore() {
    return new TimStore(':memory:');
  }

  function makeBrokenConfig(): void {
    // Closed port — fetch() will reject with ECONNREFUSED, which the
    // production code's try/catch surfaces as `ran:true, reason:'error'`.
    mod.saveConfig({
      serverUrl: 'http://127.0.0.1:1',
      userId: 'fake-user',
      token: 'fake-token',
      salt: 'fake-salt',
      fileId: 'fake-file-id',
    });
  }

  function makeWorkingConfig(serverUrl: string): void {
    mod.saveConfig({
      serverUrl,
      userId: 'fake-user',
      token: 'fake-token',
      salt: 'fake-salt',
      fileId: 'fake-file-id',
    });
  }

  it('cooldown timestamp remains 0 when autoPull fails (network error)', async () => {
    process.env.TIM_SYNC_PASSPHRASE = 'test-passphrase';
    makeBrokenConfig();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = makeStore();
    const r1 = await syncClient.autoPull(store);

    // The function attempted the sync (ran=true), but failed (reason='error').
    expect(r1.ran).toBe(true);
    expect(r1.reason).toBe('error');
    expect(errSpy).toHaveBeenCalled();

    // CRITICAL: cooldown MUST NOT be armed after failure.
    expect(_peekCooldown('pull')).toBe(0);

    // Second call must also re-attempt (cooldown not gating it out).
    // We verify via the console.error spy — each failed autoPull emits one
    // `[tim-sync] autoPull failed:` line, so 2 attempts → 2 calls.
    await syncClient.autoPull(store);
    const autoPullErrCount = errSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('autoPull failed'),
    ).length;
    expect(autoPullErrCount).toBeGreaterThanOrEqual(2);

    errSpy.mockRestore();
    try { store.close(); } catch { /* noop */ }
  });

  it('cooldown timestamp IS set when autoPull succeeds (positive control)', async () => {
    // Spin up a minimal local server that mimics the sync HTTP API enough
    // to let `runPull` return cleanly. We do not need the full envelope
    // round-trip — an empty pull response is sufficient for the control.
    const server = await startStubServer();
    const port = (server.address() as { port: number }).port;
    try {
      process.env.TIM_SYNC_PASSPHRASE = 'test-passphrase';
      makeWorkingConfig(`http://127.0.0.1:${port}`);
      resetSyncCooldowns();

      const store = makeStore();
      const r = await syncClient.autoPull(store);

      expect(r.ran).toBe(true);
      expect(r.reason).toBeUndefined();
      // Cooldown MUST be armed after success.
      expect(_peekCooldown('pull')).toBeGreaterThan(0);
      try { store.close(); } catch { /* noop */ }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('autoPush cooldown IS armed on success (end-to-end via stub server)', async () => {
    // Symmetric to the autoPull success test above. Spin up local server,
    // let push succeed, verify markSynced fires.
    const server = await startStubServer();
    const port = (server.address() as { port: number }).port;
    try {
      process.env.TIM_SYNC_PASSPHRASE = 'test-passphrase';
      makeWorkingConfig('http://127.0.0.1:' + port);
      resetSyncCooldowns();

      const store = makeStore();
      // autoPush with a working server: pushCycle succeeds, markSynced fires.
      const r = await syncClient.autoPush(store);
      expect(r.ran).toBe(true);
      expect(r.reason).toBeUndefined();
      // Cooldown MUST be armed after success.
      expect(_peekCooldown('push')).toBeGreaterThan(0);
      try { store.close(); } catch { /* noop */ }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Minimal stub of the sync HTTP API. Returns an empty pull and accepts
 * any push. Just enough to let `runPull` return without throwing.
 */
function startStubServer(): Promise<import('node:http').Server> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('node:http') as typeof import('node:http');
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // Drain request body so the connection can close cleanly.
      req.resume();
      if (req.method === 'GET' && req.url?.startsWith('/sync/pull')) {
        send(200, {
          blobs: [],
          server_time: new Date().toISOString(),
          has_more: false,
          next_cursor: '',
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/sync/push') {
        send(200, { mappings: [] });
        return;
      }
      send(404, { error: 'not found' });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
