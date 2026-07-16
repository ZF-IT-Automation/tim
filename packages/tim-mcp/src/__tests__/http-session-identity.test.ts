// TIM MCP — HTTP/SSE per-client session identity tests
//
// Spawns server.js --http via createHttpServer in-process and tests that
// two HTTP clients each get isolated session identity (no marker files
// leaked into daemon cwd, no daemon-global session-cache bleed).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('HTTP session identity', () => {
  let handle: Awaited<ReturnType<(typeof import('../server.js'))['createHttpServer']>>;
  let scratchDir: string;
  let originalCwd: string;
  let markerBefore: boolean;

  beforeEach(() => {
    originalCwd = process.cwd();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-http-id-'));
    process.chdir(scratchDir);
    markerBefore = fs.existsSync(path.join(scratchDir, '.tim-project'));
    process.env.TIM_DB_PATH = path.join(scratchDir, `test-${Date.now()}.db`);
  });

  afterEach(async () => {
    try { await handle.close(); } catch { /* ok */ }
    process.chdir(originalCwd);
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  function makeClient(url: string): Client {
    return new Client(
      { name: 'test', version: '0.0.1' },
      { capabilities: {} },
    );
  }

  it('two HTTP clients can call tools independently without session-bleed', async () => {
    const { createHttpServer } = await import('../server.js');
    handle = await createHttpServer({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    // Client A
    const clientA = makeClient(baseUrl);
    const transportA = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientA.connect(transportA);

    // Client B
    const clientB = makeClient(baseUrl);
    const transportB = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientB.connect(transportB);

    // Create a project via client A
    const createA = await clientA.callTool({
      name: 'tim_create_project',
      arguments: {
        label: 'P9001',
        content: 'Project 1 for test',
        memoryOnly: true,
      },
    });
    expect(createA.isError).toBeFalsy();
    const createPayloadA = JSON.parse((createA.content[0] as { text: string }).text);
    expect(createPayloadA).toMatchObject({
      mode: 'memory-only',
      metadata: { label: 'P9001' },
    });

    // Create a project via client B
    const createB = await clientB.callTool({
      name: 'tim_create_project',
      arguments: {
        label: 'P9002',
        content: 'Project 2 for test',
        memoryOnly: true,
      },
    });
    expect(createB.isError).toBeFalsy();
    const createPayloadB = JSON.parse((createB.content[0] as { text: string }).text);
    expect(createPayloadB).toMatchObject({
      mode: 'memory-only',
      metadata: { label: 'P9002' },
    });

    // Both clients can load their own projects
    const loadA = await clientA.callTool({
      name: 'tim_load_project',
      arguments: { label: 'P9001', bind: true },
    });
    expect(loadA.isError).toBeFalsy();
    expect((loadA.content[0] as { text: string }).text).toContain('P9001');
    expect((loadA.content[0] as { text: string }).text).not.toContain('P9002');

    const loadB = await clientB.callTool({
      name: 'tim_load_project',
      arguments: { label: 'P9002', bind: true },
    });
    expect(loadB.isError).toBeFalsy();
    expect((loadB.content[0] as { text: string }).text).toContain('P9002');
    expect((loadB.content[0] as { text: string }).text).not.toContain('P9001');

    // No .tim-project marker was created in the scratch dir
    const markerAfter = fs.existsSync(path.join(scratchDir, '.tim-project'));
    expect(markerAfter).toBe(markerBefore);

    await clientA.close();
    await clientB.close();
  });

  it('activeConnections reflects concurrent clients', async () => {
    const { createHttpServer } = await import('../server.js');
    handle = await createHttpServer({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    expect(handle.activeConnections()).toBe(0);

    const clientA = makeClient(baseUrl);
    const transportA = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientA.connect(transportA);

    // Give the connection a moment to register
    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(1);

    const clientB = makeClient(baseUrl);
    const transportB = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientB.connect(transportB);

    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(2);

    await clientA.close();
    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(1);

    await clientB.close();
    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(0);
  });
});
