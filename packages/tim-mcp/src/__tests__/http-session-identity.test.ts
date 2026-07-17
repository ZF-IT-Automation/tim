// TIM MCP — HTTP/SSE per-client session identity tests
//
// Spawns server.js --http via createHttpServer in-process and tests that
// two HTTP clients each get isolated session identity (no marker files
// leaked into daemon cwd, no daemon-global session-cache bleed).
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('HTTP session identity', () => {
  type CreateHttpServer = (typeof import('../server.js'))['createHttpServer'];
  type HttpServerHandle = Awaited<ReturnType<CreateHttpServer>>;

  let createHttpServer: CreateHttpServer;
  let handle: HttpServerHandle | undefined;
  let scratchDir: string;
  let originalCwd: string;
  let markerBefore: boolean;
  let previousTimDbPath: string | undefined;
  let identityCounter = 0;
  const clients = new Set<Client>();

  beforeAll(async () => {
    originalCwd = process.cwd();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-http-id-'));
    process.chdir(scratchDir);
    markerBefore = fs.existsSync(path.join(scratchDir, '.tim-project'));
    previousTimDbPath = process.env.TIM_DB_PATH;
    process.env.TIM_DB_PATH = path.join(scratchDir, 'test.db');
    ({ createHttpServer } = await import('../server.js'));
  });

  async function closeResources(): Promise<void> {
    const connectedClients = [...clients];
    const closeResults = await Promise.allSettled(connectedClients.map(client => client.close()));
    closeResults.forEach((result, index) => {
      if (result.status === 'fulfilled') clients.delete(connectedClients[index]);
    });

    if (handle) {
      const server = handle;
      await server.close();
      handle = undefined;
    }

    const failedClose = closeResults.find(result => result.status === 'rejected');
    if (failedClose?.status === 'rejected') throw failedClose.reason;
  }

  afterEach(closeResources);

  afterAll(async () => {
    try {
      await closeResources();
    } finally {
      process.chdir(originalCwd);
      if (previousTimDbPath === undefined) {
        delete process.env.TIM_DB_PATH;
      } else {
        process.env.TIM_DB_PATH = previousTimDbPath;
      }
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  function makeClient(): Client {
    const client = new Client(
      { name: 'test', version: '0.0.1' },
      { capabilities: {} },
    );
    clients.add(client);
    return client;
  }

  async function closeClient(client: Client): Promise<void> {
    await client.close();
    clients.delete(client);
  }

  function uniqueIdentity(): string {
    identityCounter += 1;
    return `${process.pid}-${Date.now()}-${identityCounter}`;
  }

  it('two HTTP clients can call tools independently without session-bleed', async () => {
    handle = await createHttpServer({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const identity = uniqueIdentity();
    const projectNumber = 1000 + ((Date.now() + identityCounter) % 8000);
    const labelA = `P${projectNumber}`;
    const labelB = `P${projectNumber + 1}`;
    const sessionA = `http-session-${identity}-A`;
    const sessionB = `http-session-${identity}-B`;

    // Client A
    const clientA = makeClient();
    const transportA = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientA.connect(transportA);

    // Client B
    const clientB = makeClient();
    const transportB = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientB.connect(transportB);

    // Create a project via client A
    const createA = await clientA.callTool({
      name: 'tim_create_project',
      arguments: {
        label: labelA,
        content: 'Project 1 for test',
        memoryOnly: true,
      },
    });
    expect(createA.isError).toBeFalsy();
    const createPayloadA = JSON.parse((createA.content[0] as { text: string }).text);
    expect(createPayloadA).toMatchObject({
      mode: 'memory-only',
      metadata: { label: labelA },
    });

    // Create a project via client B
    const createB = await clientB.callTool({
      name: 'tim_create_project',
      arguments: {
        label: labelB,
        content: 'Project 2 for test',
        memoryOnly: true,
      },
    });
    expect(createB.isError).toBeFalsy();
    const createPayloadB = JSON.parse((createB.content[0] as { text: string }).text);
    expect(createPayloadB).toMatchObject({
      mode: 'memory-only',
      metadata: { label: labelB },
    });

    // Both clients can load their own projects
    const loadA = await clientA.callTool({
      name: 'tim_load_project',
      arguments: { label: labelA, sessionId: sessionA, bind: true },
    });
    expect(loadA.isError).toBeFalsy();
    expect((loadA.content[0] as { text: string }).text).toContain(labelA);
    expect((loadA.content[0] as { text: string }).text).not.toContain(labelB);

    const loadB = await clientB.callTool({
      name: 'tim_load_project',
      arguments: { label: labelB, sessionId: sessionB, bind: true },
    });
    expect(loadB.isError).toBeFalsy();
    expect((loadB.content[0] as { text: string }).text).toContain(labelB);
    expect((loadB.content[0] as { text: string }).text).not.toContain(labelA);

    const crossLoadA = await clientA.callTool({
      name: 'tim_load_project',
      arguments: { label: labelB, sessionId: sessionA, bind: true },
    });
    expect(crossLoadA.isError).toBe(true);
    expect((crossLoadA.content[0] as { text: string }).text).toContain(`already bound to ${labelA}`);

    const crossLoadB = await clientB.callTool({
      name: 'tim_load_project',
      arguments: { label: labelA, sessionId: sessionB, bind: true },
    });
    expect(crossLoadB.isError).toBe(true);
    expect((crossLoadB.content[0] as { text: string }).text).toContain(`already bound to ${labelB}`);

    // No .tim-project marker was created in the scratch dir
    const markerAfter = fs.existsSync(path.join(scratchDir, '.tim-project'));
    expect(markerAfter).toBe(markerBefore);

    await closeClient(clientA);
    await closeClient(clientB);
  });

  it('activeConnections reflects concurrent clients', async () => {
    handle = await createHttpServer({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    expect(handle.activeConnections()).toBe(0);

    const clientA = makeClient();
    const transportA = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientA.connect(transportA);

    // Give the connection a moment to register
    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(1);

    const clientB = makeClient();
    const transportB = new SSEClientTransport(new URL(`${baseUrl}/sse`));
    await clientB.connect(transportB);

    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(2);

    await closeClient(clientA);
    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(1);

    await closeClient(clientB);
    await new Promise(r => setTimeout(r, 100));
    expect(handle.activeConnections()).toBe(0);
  });
});
