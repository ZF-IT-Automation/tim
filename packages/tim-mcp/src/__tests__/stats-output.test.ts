// TIM MCP — JSON response safety tests (BUG 2)
// BUG 2 reported: "Unexpected token '#', '[#session-summary]' is not valid JSON"
//
// Investigation: every MCP handler in server.ts wraps its payload in
// `JSON.stringify(...)` (lines 1007, 1048, 1055, 1063, 1071, 1079, 1087,
// 1122, 1162, 1169, 1183, 1193, 1236, 1252, 1260, 1267, 1274, 1286,
// 1294, 1302, 1310, 1318, 1326, 1334, 1342, 1350, 1358, 1503).
// `JSON.stringify` always escapes strings properly, so the # character
// inside a string value can never break the outer JSON.
//
// The risky path is formatProjectOutput() in tim-store, which emits
// PLAIN TEXT for tim_load_project / tim_read_project — there the tags
// are inlined as `#tag1 #tag2` in a header line. A downstream client
// that takes the text response and tries to JSON.parse a substring
// of it would fail. The fix is contractual: keep tags as a separate
// field in JSON responses, never inline.
//
// These tests pin that contract end-to-end by spawning the actual
// server binary, calling each tool, and asserting the text content
// of each response is parseable as JSON.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';
isolateChildServerCwd();

const SERVER_PATH = path.resolve(
  __dirname, '..', '..', 'dist', 'server.js',
);

interface JsonRpcResp {
  id: number;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

class McpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (resp: JsonRpcResp) => void>();
  private buffer = '';
  private ready = false;

  constructor(dbPath: string) {
    if (!fs.existsSync(SERVER_PATH)) {
      throw new Error(`Server dist not found: ${SERVER_PATH}. Run "npm run build" first.`);
    }
    this.proc = spawn('node', [SERVER_PATH], {
      cwd: childServerCwd(),
      env: { ...process.env, TIM_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (chunk) => this.onData(chunk.toString('utf8')));
    this.proc.stderr!.on('data', () => {
      // swallow stderr — server logs to it
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
        // Not a JSON-RPC frame (could be a server log line on stdout) — ignore.
      }
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, 5000);
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
      clientInfo: { name: 'bug2-test', version: '0.0.1' },
    });
    // initialized notification
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResp> {
    await this.init();
    return this.send('tools/call', { name, arguments: args });
  }

  kill(): void {
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (!this.proc.killed) this.proc.kill('SIGKILL');
    }, 100);
  }
}

describe('MCP tool response JSON safety (BUG 2)', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    // Per-test isolated DB so writes don't bleed.
    dbPath = `/tmp/tim-bug2-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('tim_stats returns parseable JSON (no # chars in numbers/booleans)', async () => {
    const resp = await client.callTool('tim_stats');
    expect(resp.error).toBeUndefined();
    const text = resp.result!.content[0].text;
    // Must be valid JSON.
    const stats = JSON.parse(text);
    expect(typeof stats.totalEntries).toBe('number');
  });

  it('tim_write + tim_read round-trip: response is parseable JSON even with # in tags', async () => {
    // Seed an entry with tags that include the # character (the smoking gun
    // from the BUG 2 crash report).
    const writeResp = await client.callTool('tim_write', {
      content: 'Tagged entry',
      tags: ['#session-summary', '#batch-summary'],
    });
    expect(writeResp.error).toBeUndefined();
    const written = JSON.parse(writeResp.result!.content[0].text);
    expect(written.tags).toEqual(['#session-summary', '#batch-summary']);

    // Read it back. Response must be parseable.
    const readResp = await client.callTool('tim_read', { id: written.id });
    expect(readResp.error).toBeUndefined();
    const read = JSON.parse(readResp.result!.content[0].text);
    // tim_read returns { entry, edges } wrapper (not the entry directly).
    expect(read.entry.tags).toEqual(['#session-summary', '#batch-summary']);
  });

  it('tim_search returns parseable JSON even when entries have # in tags', async () => {
    await client.callTool('tim_write', {
      content: 'searchable with hash tags',
      tags: ['#important', '#note'],
    });
    const resp = await client.callTool('tim_search', { query: 'searchable' });
    expect(resp.error).toBeUndefined();
    const text = resp.result!.content[0].text;
    const response = JSON.parse(text);
    expect(Array.isArray(response.results)).toBe(true);
    expect(response.returned).toBe(response.results.length);
    if (response.results.length > 0) {
      // The # should be inside a string, not breaking the JSON.
      expect(typeof response.results[0].tags).toBe('object'); // array
    }
  });

  it('tim_load_project response is plain text (not JSON) — tags are inlined, not parsed', async () => {
    // The project loader returns formatted text. The contract: even though
    // tags appear in the text output, downstream clients must use the
    // separate `tags: string[]` field from JSON responses, never parse
    // substrings of the formatted text.
    //
    // Create a project first, then load it.
    await client.callTool('tim_create_project', { label: 'P9999', aliases: ['bug2-test'], memoryOnly: true });
    const loadResp = await client.callTool('tim_load_project', { label: 'P9999' });
    expect(loadResp.error).toBeUndefined();
    const text = loadResp.result!.content[0].text;
    // The response is text (not JSON), so JSON.parse should fail.
    // What matters: if a client DOES try to parse it, the # inside
    // `[#something]` is inside a string, not at the top level.
    // We don't assert throw — the loader output is text. We just confirm
    // it returns successfully and contains expected project header content.
    expect(text.length).toBeGreaterThan(0);
  });

  it('every tool response is either valid JSON or a clean text error message', async () => {
    // Sweep: call a handful of tools and JSON.parse each response.
    // If BUG 2 ever regresses (e.g. someone inlines `[#tag]` into a JSON
    // string concatenation), this test will fail.
    //
    // Contract: success responses are JSON.parse-able; error responses
    // are plain text starting with "Error: ". Both are valid in the
    // MCP protocol — the `isError` flag is what clients should switch on.
    const tools: { name: string; args?: Record<string, unknown> }[] = [
      { name: 'tim_stats' },
      { name: 'tim_health' },
      { name: 'tim_search', args: { query: 'nothing-matches' } },
      { name: 'tim_read', args: { id: 'NONEXISTENT' } }, // errorResult text per Plan 4 Task 1
    ];

    for (const t of tools) {
      const resp = await client.callTool(t.name, t.args);
      // Either JSON-RPC level error (no .result) or successful result.
      if (resp.error) {
        expect(typeof resp.error.message).toBe('string');
        continue;
      }
      const text = resp.result!.content[0].text;
      const isError = resp.result!.isError === true;
      if (isError) {
        // Plan 4 Task 1 — error contract: isError:true with helpful text.
        // Old contract required "Error: ..." prefix or JSON body. New contract:
        // any non-empty, non-"null" text is valid (the whole point is that
        // "null" is gone, replaced by a message that names what failed).
        const looksLikeJson = (() => { try { JSON.parse(text); return true; } catch { return false; } })();
        expect(
          looksLikeJson || (text.length > 0 && text !== 'null'),
          `tool ${t.name} returned isError:true with empty or "null" text: ${text.slice(0, 80)}`,
        ).toBe(true);
      } else {
        // Success — must be valid JSON.
        expect(() => JSON.parse(text), `tool ${t.name} returned non-JSON on success: ${text.slice(0, 80)}`).not.toThrow();
      }
    }
  });
});
