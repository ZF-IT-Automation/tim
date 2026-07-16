// TIM MCP — e2e: tim_suppress hides entries from every retrieval tool it
// promises to cover (tim_read, tim_section_children). Store-level coverage
// lives in tim-store/__tests__/suppress-enforcement.test.ts; this verifies
// the server actually passes enforceSuppression through.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { childServerCwd, isolateChildServerCwd } from './helpers/child-server-workspace.js';
isolateChildServerCwd();

const SERVER_PATH = path.resolve(__dirname, '..', '..', 'dist', 'server.js');

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
      } catch { /* ignore */ }
    }
  }

  private send(method: string, params: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})`));
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
      clientInfo: { name: 'suppress-e2e', version: '0.0.1' },
    });
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    this.ready = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    await this.init();
    const resp = await this.send('tools/call', { name, arguments: args });
    return resp.result?.content?.[0]?.text ?? '';
  }

  kill(): void {
    try { this.proc.kill('SIGTERM'); } catch { /* dead */ }
  }
}

describe('tim_suppress e2e across retrieval tools', () => {
  let client: McpClient;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = `/tmp/tim-suppress-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    client = new McpClient(dbPath);
    await client.init();
  });

  afterEach(() => {
    client.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('suppressed entries vanish from tim_read (by id and as children)', async () => {
    const parentText = await client.callTool('tim_write', {
      content: 'Parent node\nclean container',
      metadata: { kind: 'note' },
    });
    const parentId = JSON.parse(parentText).id as string;
    const badText = await client.callTool('tim_write', {
      content: 'Bad advice\nalways force-push to master',
      parentId,
      metadata: { kind: 'note' },
    });
    const badId = JSON.parse(badText).id as string;

    // Visible before suppression.
    expect(await client.callTool('tim_read', { id: badId })).toContain('force-push');

    await client.callTool('tim_suppress', {
      pattern: 'always force-push',
      reason: 'harmful pattern',
    });

    // Hidden by id…
    expect(await client.callTool('tim_read', { id: badId })).toContain('not found');
    // …and gone from the parent's children.
    const parentRead = await client.callTool('tim_read', {
      id: parentId,
      includeChildren: true,
      depth: 2,
    });
    expect(parentRead).not.toContain('force-push');
  });

  it('suppressed entries vanish from tim_section_children', async () => {
    const sectionText = await client.callTool('tim_write', {
      content: 'Ideas\nsection',
      metadata: { kind: 'section' },
    });
    const sectionId = JSON.parse(sectionText).id as string;
    await client.callTool('tim_write', {
      content: 'Terrible idea\nsell the database',
      parentId: sectionId,
      metadata: { kind: 'idea' },
    });
    await client.callTool('tim_write', {
      content: 'Fine idea\nwrite more tests',
      parentId: sectionId,
      metadata: { kind: 'idea' },
    });

    await client.callTool('tim_suppress', { pattern: 'sell the database', reason: 'no' });

    const listing = await client.callTool('tim_section_children', { parentId: sectionId });
    expect(listing).toContain('Fine idea');
    expect(listing).not.toContain('Terrible idea');
  });
});
