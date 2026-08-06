import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore } from 'tim-store';
import {
  startViewer,
  assertLoopbackHost,
  NonLoopbackBindError,
  type ViewerHandle,
} from '../viewer-server.js';
import { ViewerData, REDACTED_TITLE } from '../viewer-data.js';

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

describe('viewer read-only guarantee', () => {
  it('rejects every non-GET method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/node?id=NOTE-1`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
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
