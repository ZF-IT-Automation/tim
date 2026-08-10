import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import {
  startViewer,
  assertLoopbackHost,
  NonLoopbackBindError,
  requireSameOrigin,
  type ViewerHandle,
} from '../viewer-server.js';
import { ViewerData, REDACTED_TITLE } from '../viewer-data.js';
import { inspectorToolArgs, parseDoctorDbPath } from '../viewer-tools.js';

// Deliberately wider than the MCP renderer's MAX_CHILDREN_PER_LEVEL (10).
const WIDE_CHILD_COUNT = 25;
const LONG_BODY = 'x'.repeat(5000);

let tmpDir: string;
let dbPath: string;
let handle: ViewerHandle;
let base: string;

interface Json {
  [key: string]: any;
}

async function get(pathname: string): Promise<{ status: number; body: Json }> {
  const res = await fetch(base + pathname);
  return { status: res.status, body: (await res.json()) as Json };
}

async function seed(): Promise<void> {
  const store = new TimStore(dbPath);

  await store.write('TIM Viewer Fixture', {
    id: 'PROJ-1',
    title: 'TIM Viewer Fixture',
    metadata: { kind: 'project', label: 'P0001', path: '/tmp/fixture' },
  });
  await store.write('Second Project', {
    id: 'PROJ-2',
    title: 'Second Project',
    metadata: { kind: 'project', label: 'P0002' },
  });

  // A section the CLI renderer would skip entirely (render_depth=0).
  await store.write('Hidden From Renderer', {
    id: 'SEC-HIDDEN',
    title: 'Hidden From Renderer',
    parentId: 'PROJ-1',
    metadata: { kind: 'section', order: 1, render_depth: 0 },
  });
  await store.write('child of hidden section', {
    id: 'SEC-HIDDEN-KID',
    title: 'child of hidden section',
    parentId: 'SEC-HIDDEN',
    metadata: { kind: 'note', order: 1 },
  });

  await store.write('Notes', {
    id: 'SEC-NOTES',
    title: 'Notes',
    parentId: 'PROJ-1',
    metadata: { kind: 'section', order: 2 },
  });
  for (let i = 1; i <= WIDE_CHILD_COUNT; i++) {
    await store.write(i === 1 ? LONG_BODY : `note body ${i}`, {
      id: `NOTE-${i}`,
      title: `Note ${i}`,
      parentId: 'SEC-NOTES',
      tags: ['#fixture'],
      metadata: { kind: 'note', order: i },
    });
  }
  // Soft-deleted child: must not appear in children, must be counted.
  await store.write('deleted note', {
    id: 'NOTE-DELETED',
    title: 'Deleted Note',
    parentId: 'SEC-NOTES',
    metadata: { kind: 'note', order: 99 },
  });
  await store.delete('NOTE-DELETED');

  // Parentless entries that are not projects. ROOT-BARE carries no `kind` at
  // all, which is the case a plain `json_extract(...) != 'project'` silently
  // drops (NULL != 'project' is NULL, not true).
  await store.write('loose root with a kind', {
    id: 'ROOT-KINDED',
    title: 'Loose Root With Kind',
    metadata: { kind: 'note' },
  });
  await store.write('loose root without a kind', {
    id: 'ROOT-BARE',
    title: 'Loose Root Without Kind',
  });

  // Session subtree: Sessions -> session -> Summary/Exchanges -> batches -> turns.
  await store.write('Sessions', {
    id: 'SESSIONS',
    title: 'Sessions',
    parentId: 'PROJ-1',
    metadata: { kind: 'sessions-root', order: 1000 },
  });
  await store.write('Session 2026-08-05', {
    id: 'SESSION-1',
    title: 'Session 2026-08-05',
    parentId: 'SESSIONS',
    metadata: { kind: 'session', order: 1 },
  });
  await store.write('Summary', {
    id: 'SUMMARY-1',
    title: 'Summary',
    parentId: 'SESSION-1',
    metadata: { kind: 'session-summary-root', order: 1 },
  });
  await store.write(LONG_BODY, {
    id: 'BATCHSUM-1',
    title: 'Batch 1 summary',
    parentId: 'SUMMARY-1',
    metadata: { kind: 'batch-summary', batch_index: 1 },
  });
  await store.write('Exchanges', {
    id: 'EXCHANGES-1',
    title: 'Exchanges',
    parentId: 'SESSION-1',
    metadata: { kind: 'exchanges-root', order: 2 },
  });
  await store.write('Batch 1', {
    id: 'XBATCH-1',
    title: 'Batch 1',
    parentId: 'EXCHANGES-1',
    metadata: { kind: 'exchange-batch', batch_index: 1, order: 1 },
  });
  // Inserted out of order on purpose — the viewer must sort by seq.
  await store.write('agent turn', {
    id: 'TURN-2',
    title: 'agent turn',
    parentId: 'XBATCH-1',
    metadata: { kind: 'exchange', role: 'agent', seq: 2 },
  });
  await store.write('user turn', {
    id: 'TURN-1',
    title: 'user turn',
    parentId: 'XBATCH-1',
    metadata: { kind: 'exchange', role: 'user', seq: 1 },
  });

  // Secret subtree under the second project.
  await store.write('Credentials', {
    id: 'SECRET-ROOT',
    title: 'Credentials',
    parentId: 'PROJ-2',
    tags: ['#private'],
    metadata: { kind: 'section', order: 1, secret: true, render_depth: 2 },
  });
  await store.write('token: hunter2', {
    id: 'SECRET-CHILD',
    title: 'Production token',
    parentId: 'SECRET-ROOT',
    metadata: { kind: 'note', order: 1 },
  });

  store.close();
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-viewer-'));
  dbPath = path.join(tmpDir, 'tim.db');
  await seed();
  handle = await startViewer({ dbPath, port: 0 });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('viewer project list', () => {
  it('lists every metadata.kind=project entry with child counts', async () => {
    const { status, body } = await get('/api/projects');
    expect(status).toBe(200);
    expect(body.projects.map((p: Json) => p.label)).toEqual(['P0001', 'P0002']);
    const p1 = body.projects[0];
    expect(p1.id).toBe('PROJ-1');
    expect(p1.kind).toBe('project');
    expect(p1.childCount).toBe(3); // hidden section + notes + sessions
  });
});

describe('viewer children endpoint', () => {
  it('returns every child with no cap', async () => {
    const { body } = await get('/api/children?id=SEC-NOTES');
    expect(body.children).toHaveLength(WIDE_CHILD_COUNT);
    expect(body.children[0].title).toBe('Note 1');
    expect(body.children[WIDE_CHILD_COUNT - 1].title).toBe(`Note ${WIDE_CHILD_COUNT}`);
  });

  it('counts soft-deleted children instead of hiding them silently', async () => {
    const { body } = await get('/api/children?id=SEC-NOTES');
    expect(body.children.some((c: Json) => c.id === 'NOTE-DELETED')).toBe(false);
    expect(body.parent.hiddenChildCount).toBe(1);
    expect(body.parent.childCount).toBe(WIDE_CHILD_COUNT);
  });

  it('lists soft-deleted children on request, flagged rather than merely counted', async () => {
    const { body } = await get('/api/children?id=SEC-NOTES&hidden=1');
    expect(body.children).toHaveLength(WIDE_CHILD_COUNT + 1);
    const deleted = body.children.find((c: Json) => c.id === 'NOTE-DELETED');
    expect(deleted.hidden).toBe(true);
    // Live siblings must not pick up the flag.
    expect(body.children.find((c: Json) => c.id === 'NOTE-1').hidden).toBe(false);
  });

  it('offers parentless non-project entries as roots, including kind-less ones', async () => {
    const { body } = await get('/api/projects');
    const ids = body.otherRoots.map((r: Json) => r.id);
    expect(ids).toContain('ROOT-KINDED');
    expect(ids).toContain('ROOT-BARE');
    // Projects stay in their own list; a root must not appear twice.
    expect(ids).not.toContain('PROJ-1');
    expect(body.projects.map((p: Json) => p.id)).toContain('PROJ-1');
  });

  it('shows render_depth=0 nodes and their subtree, exposing render_depth as data', async () => {
    const { body } = await get('/api/children?id=PROJ-1');
    const hidden = body.children.find((c: Json) => c.id === 'SEC-HIDDEN');
    expect(hidden).toBeDefined();
    expect(hidden.renderDepth).toBe(0);
    expect(hidden.childCount).toBe(1);

    const kids = await get('/api/children?id=SEC-HIDDEN');
    expect(kids.body.children.map((c: Json) => c.id)).toEqual(['SEC-HIDDEN-KID']);
  });

  it('accepts a project label as well as an entry id', async () => {
    const { status, body } = await get('/api/children?id=P0001');
    expect(status).toBe(200);
    expect(body.parent.id).toBe('PROJ-1');
  });

  it('orders session turns by seq, not insertion order', async () => {
    const { body } = await get('/api/children?id=XBATCH-1');
    expect(body.children.map((c: Json) => c.id)).toEqual(['TURN-1', 'TURN-2']);
    expect(body.children[0].seq).toBe(1);
  });

  it('walks the session subtree from session to summary and exchanges', async () => {
    const session = await get('/api/children?id=SESSION-1');
    expect(session.body.children.map((c: Json) => c.kind)).toEqual([
      'session-summary-root',
      'exchanges-root',
    ]);
    const summary = await get('/api/children?id=SUMMARY-1');
    expect(summary.body.children[0].kind).toBe('batch-summary');
    expect(summary.body.children[0].batchIndex).toBe(1);
  });

  it('400s without an id and 404s on an unknown id', async () => {
    expect((await get('/api/children')).status).toBe(400);
    expect((await get('/api/children?id=NOPE')).status).toBe(404);
  });
});

describe('viewer node detail', () => {
  it('returns the full body and complete metadata', async () => {
    const { body } = await get('/api/node?id=NOTE-1');
    const node = body.node;
    expect(node.content).toHaveLength(LONG_BODY.length);
    expect(node.contentChars).toBe(LONG_BODY.length);
    expect(node.tags).toEqual(['#fixture']);
    expect(node.metadata).toMatchObject({ kind: 'note', order: 1 });
  });

  it('returns the full batch summary text untruncated', async () => {
    const { body } = await get('/api/node?id=BATCHSUM-1');
    expect(body.node.content).toHaveLength(LONG_BODY.length);
  });

  it('includes a root-first ancestor path', async () => {
    const { body } = await get('/api/node?id=TURN-1');
    expect(body.node.path.map((c: Json) => c.id)).toEqual([
      'PROJ-1',
      'SESSIONS',
      'SESSION-1',
      'EXCHANGES-1',
      'XBATCH-1',
    ]);
  });

  it('404s on an unknown id', async () => {
    expect((await get('/api/node?id=NOPE')).status).toBe(404);
  });
});

describe('viewer stats', () => {
  it('reports read-only mode, counts and redaction mode', async () => {
    const { body } = await get('/api/stats');
    expect(body.readOnly).toBe(true);
    expect(body.showSecrets).toBe(false);
    expect(body.projectCount).toBe(2);
    expect(body.hiddenEntries).toBe(1);
    expect(body.secretEntries).toBe(2);
    expect(body.databasePath).toBe(fs.realpathSync(dbPath));
  });
});

describe('viewer secret handling', () => {
  it('redacts secret subtrees by default, keeping structural metadata', async () => {
    const { body } = await get('/api/node?id=SECRET-CHILD');
    const node = body.node;
    expect(node.secret).toBe(true);
    expect(node.redacted).toBe(true);
    expect(node.title).toBe(REDACTED_TITLE);
    expect(node.content).toBeNull();
    expect(node.tags).toEqual([]);
    expect(node.metadata).toEqual({ kind: 'note', order: 1, secret: true });
  });

  it('marks inherited secrecy on children of a secret node', async () => {
    const { body } = await get('/api/children?id=SECRET-ROOT');
    expect(body.children[0].secret).toBe(true);
    expect(body.children[0].title).toBe(REDACTED_TITLE);
  });

  it('renders secret content only with the explicit opt-in', () => {
    const data = ViewerData.open(dbPath, { showSecrets: true });
    try {
      const node = data.node('SECRET-CHILD');
      expect(node!.title).toBe('Production token');
      expect(node!.content).toContain('hunter2');
      expect(node!.metadata).toMatchObject({ secret: true });
    } finally {
      data.close();
    }
  });
});

describe('viewer tool panel', () => {
  it('offers read tools only — no writes, no tim_sync, no tim_export', async () => {
    const { body } = await get('/api/tools');
    const names = body.tools.map((t: Json) => t.name);
    expect(names).toContain('tim_read');
    expect(names).toContain('tim_preview_briefing');
    // tim_sync pushes to the sync server; tim_export writes a file to disk.
    // Both sit in the server's READ_TOOLS, which is why the allowlist is its own.
    for (const denied of ['tim_write', 'tim_update', 'tim_delete', 'tim_sync', 'tim_export']) {
      expect(names).not.toContain(denied);
    }
  });

  it('ships a JSON schema for every tool it offers', async () => {
    const { body } = await get('/api/tools');
    expect(body.tools.length).toBeGreaterThan(0);
    for (const tool of body.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.description).toBe('string');
    }
  });

  it('refuses a tool outside the allowlist before any connection is attempted', async () => {
    const { status, body } = await get(
      '/api/tool?name=tim_write&args=' + encodeURIComponent('{"content":"x"}'),
    );
    // 403, not 502: the refusal is the viewer's, and it happens whether or not
    // an MCP server is running.
    expect(status).toBe(403);
    expect(body.error).toMatch(/not callable from the viewer/);
  });

  it('rejects args that are not a JSON object', async () => {
    expect((await get('/api/tool?name=tim_read&args=%5B1%5D')).status).toBe(400);
    expect((await get('/api/tool?name=tim_read&args=notjson')).status).toBe(400);
    expect((await get('/api/tool')).status).toBe(400);
  });

  it('pins bind:false on tim_load_project even when the form asks to bind', () => {
    // bind:true would start a project session and write a .tim-project marker.
    expect(inspectorToolArgs('tim_load_project', { label: 'P0001', bind: true }))
      .toEqual({ label: 'P0001', bind: false });
    // Other tools pass through untouched.
    expect(inspectorToolArgs('tim_read', { id: 'P0001' })).toEqual({ id: 'P0001' });
  });

  it('declares the pinned argument instead of applying it invisibly', async () => {
    const { body } = await get('/api/tools');
    const load = body.tools.find((t: Json) => t.name === 'tim_load_project');
    expect(load.forced).toEqual({ bind: false });
  });

  it('reports an unreachable MCP server as 502 with an actionable message', async () => {
    // Port 1 is never the MCP server; the panel must fail loudly, and must say
    // that the tree is unaffected.
    const previous = process.env.TIM_MCP_PORT;
    process.env.TIM_MCP_PORT = '1';
    try {
      const { status, body } = await get('/api/tool?name=tim_stats&args=%7B%7D');
      expect(status).toBe(502);
      expect(body.error).toMatch(/Cannot reach the TIM MCP server/);
      expect(body.error).toMatch(/the tree does not/);
    } finally {
      if (previous === undefined) delete process.env.TIM_MCP_PORT;
      else process.env.TIM_MCP_PORT = previous;
    }
  });
});

describe('viewer read-only guarantee', () => {
  it('rejects every non-GET method outside the one mutation route', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/node?id=NOTE-1`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD, POST');
    }
  });

  it('opens SQLite read-only so the driver itself refuses writes', () => {
    const db = handle.data.getDb();
    expect(db.readonly).toBe(true);
    expect(() => db.prepare('DELETE FROM entries').run()).toThrow(/readonly/i);
    expect(() =>
      db.prepare("UPDATE entries SET title = 'x' WHERE id = 'NOTE-1'").run(),
    ).toThrow(/readonly/i);
    // Reads still work — the handle is usable, just not writable.
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c,
    ).toBeGreaterThan(0);
  });

  it('leaves the database byte-identical after a full browse', async () => {
    const before = fs.readFileSync(dbPath);
    await get('/api/projects');
    await get('/api/children?id=PROJ-1');
    await get('/api/node?id=NOTE-1');
    await get('/api/stats');
    await fetch(`${base}/api/node?id=NOTE-1`, { method: 'DELETE' });
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });
});

describe('viewer binding', () => {
  it('accepts loopback hosts only', () => {
    expect(() => assertLoopbackHost('127.0.0.1')).not.toThrow();
    expect(() => assertLoopbackHost('localhost')).not.toThrow();
    expect(() => assertLoopbackHost('::1')).not.toThrow();
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(() => assertLoopbackHost(host)).toThrow(NonLoopbackBindError);
    }
  });

  it('refuses to start on a non-loopback host', async () => {
    await expect(startViewer({ dbPath, port: 0, host: '0.0.0.0' })).rejects.toThrow(
      NonLoopbackBindError,
    );
  });

  it('binds the listening socket to loopback', () => {
    const address = handle.server.address();
    expect(address && typeof address === 'object' ? address.address : null).toBe('127.0.0.1');
  });
});

describe('viewer CLI wiring', () => {
  // Source-level rather than spawn-based: help-safety.test.ts runs against
  // dist/, which is a build artifact this change does not regenerate.
  const cliSource = fs.readFileSync(path.resolve(__dirname, '..', 'cli.ts'), 'utf8');

  it('declares help text, a root-help line and a dispatch case', () => {
    expect(cliSource).toMatch(/viewer:\s*\n?\s*'Usage: tim viewer/);
    expect(cliSource).toMatch(/^\s+viewer\s+Browse the entry tree/m);
    expect(cliSource).toMatch(/case 'viewer':\s*\n\s*await cmdViewer\(rest\);/);
  });

  it('registers its value options with the shared parser', async () => {
    const { valueOptionsFor } = await import('../args.js');
    expect([...valueOptionsFor('viewer')].sort()).toEqual(['db', 'host', 'port']);
  });
});

describe('viewer page', () => {
  it('serves a self-contained page with no external references', async () => {
    const res = await fetch(base + '/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).not.toMatch(/src=["']https?:/i);
    expect(html).not.toMatch(/href=["']https?:/i);
    expect(html).not.toMatch(/@import/);
  });
});

// POST /api/mutate is the only route in this server that can change the database
// (indirectly, via the MCP server). These tests cover the guards in front of it;
// what the tools themselves do is tim-store's and tim-mcp's business.
describe('viewer mutation route', () => {
  async function mutate(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json }> {
    const res = await fetch(base + '/api/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }

  it('rejects a tool that is not on the mutation allowlist', async () => {
    const { status, body } = await mutate({ name: 'tim_write', args: { title: 'x' } });
    expect(status).toBe(403);
    expect(body.error).toMatch(/not callable from the viewer/);
  });

  it('rejects read tools too — the two allowlists are separate', async () => {
    const { status } = await mutate({ name: 'tim_read', args: { id: 'NOTE-1' } });
    expect(status).toBe(403);
  });

  it('rejects a cross-site request even with a valid tool name', async () => {
    const { status, body } = await mutate(
      { name: 'tim_delete', args: { id: 'NOTE-1' } },
      { 'Sec-Fetch-Site': 'cross-site' },
    );
    expect(status).toBe(403);
    expect(body.error).toMatch(/Cross-site/);
  });

  it('rejects a foreign Origin', async () => {
    const { status, body } = await mutate(
      { name: 'tim_delete', args: { id: 'NOTE-1' } },
      { Origin: 'http://evil.example' },
    );
    expect(status).toBe(403);
    expect(body.error).toMatch(/Cross-origin/);
  });

  it('rejects a form-encoded body, which is what a CORS-simple attack would send', async () => {
    const res = await fetch(base + '/api/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'tim_delete', args: { id: 'NOTE-1' } }),
    });
    expect(res.status).toBe(415);
  });

  it('requires a tool name', async () => {
    const { status, body } = await mutate({ args: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name required/);
  });

  it('reaches the MCP server for an allowed tool (502 here — none is running)', async () => {
    const previous = process.env.TIM_MCP_PORT;
    process.env.TIM_MCP_PORT = '1';
    try {
      const { status, body } = await mutate({ name: 'tim_delete', args: { id: 'NOTE-1' } });
      expect(status).toBe(502);
      expect(body.error).toMatch(/Cannot reach the TIM MCP server/);
    } finally {
      if (previous === undefined) delete process.env.TIM_MCP_PORT;
      else process.env.TIM_MCP_PORT = previous;
    }
  });

  it('leaves the viewer own handle read-only', () => {
    expect(handle.data.getDb().readonly).toBe(true);
  });
});

describe('requireSameOrigin', () => {
  it('allows a same-origin browser request', () => {
    expect(
      requireSameOrigin({ 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:7373` }, 7373),
    ).toBeNull();
  });

  it('allows a non-browser client with neither header', () => {
    expect(requireSameOrigin({}, 7373)).toBeNull();
  });

  it('rejects loopback on a different port — another local app is not this one', () => {
    expect(requireSameOrigin({ origin: 'http://127.0.0.1:9999' }, 7373)).toMatch(/Cross-origin/);
  });

  it('rejects an unparseable Origin rather than falling through', () => {
    expect(requireSameOrigin({ origin: 'not a url' }, 7373)).toMatch(/unparseable/);
  });
});

describe('parseDoctorDbPath', () => {
  it('reads the database path out of a real tim_doctor header', () => {
    expect(
      parseDoctorDbPath('TIM Doctor — /home/u/.tim/tim.db\nEntries: 10102 | Edges: 1137'),
    ).toBe('/home/u/.tim/tim.db');
  });

  it('returns null when the header is absent, so the caller can fail closed', () => {
    expect(parseDoctorDbPath('Entries: 3')).toBeNull();
    expect(parseDoctorDbPath('')).toBeNull();
  });
});
