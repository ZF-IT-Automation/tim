// `tim viewer` HTTP server — plain node:http, same idiom as tim-sync-server.
//
// This process never writes the database: the store handle is opened readonly, and
// every GET route is served from it. Two routes forward to the MCP server, which
// holds the writable store:
//
//   GET  /api/tool    read tools (INSPECTOR_TOOLS). They change no memory, but do
//                     touch accessed_at and usage telemetry — the guarantee is
//                     "no memory changes", not "no bytes written".
//   POST /api/mutate  structure edits (MUTATION_TOOLS): move a node, soft-delete a
//                     node or a subtree. Nothing on that list can change what an
//                     entry says, and assertSameDatabase refuses the call unless
//                     that server holds the very database the viewer is rendering.
//
// The POST route is the reason this file has a CSRF guard. The viewer binds
// loopback and has no authentication, so any page in the user's browser can send
// it a cross-origin POST; requireSameOrigin below is what stops one from
// rearranging the memory tree. GET stays free of it — reads were already
// reachable by navigation.

import http from 'node:http';
import { ViewerData } from './viewer-data.js';
import { VIEWER_PAGE } from './viewer-page.js';
import {
  assertSameDatabase,
  callInspectorTool,
  callMutationTool,
  listInspectorTools,
  MUTATION_TOOLS,
  ToolNotAllowedError,
} from './viewer-tools.js';

/** Hosts that resolve to the loopback interface. Nothing else may bind. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

export class NonLoopbackBindError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(
      `Refusing to bind tim viewer to "${host}" — the viewer serves private memory ` +
        'unauthenticated and may only listen on loopback (127.0.0.1, ::1, localhost).',
    );
    this.name = 'NonLoopbackBindError';
    this.host = host;
  }
}

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) throw new NonLoopbackBindError(host);
}

export interface ViewerServerOptions {
  dbPath: string;
  port?: number;
  host?: string;
  showSecrets?: boolean;
}

export interface ViewerHandle {
  server: http.Server;
  data: ViewerData;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The page is fully inlined; forbid any outbound fetch so an injected
    // string in stored memory can never phone home.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

/**
 * Whether a mutating request came from the viewer's own page.
 *
 * Two independent checks, because either one alone has a gap:
 *   - `Origin` is sent on every cross-origin POST, so a mismatch is decisive —
 *     but same-origin fetches may omit it entirely, which is why absence passes.
 *   - `Sec-Fetch-Site` closes that gap in browsers that send it. A request with
 *     no Origin *and* no Sec-Fetch-Site is not from a browser at all (curl, a
 *     test) and is allowed: the viewer is loopback-only, so anything that can
 *     open a socket to it can already read the whole database.
 */
export function requireSameOrigin(
  headers: http.IncomingHttpHeaders,
  port: number,
): string | null {
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return `Cross-site request rejected (Sec-Fetch-Site: ${site})`;
  }

  const origin = headers.origin;
  if (typeof origin !== 'string' || origin === '') return null;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return `Cross-origin request rejected (unparseable Origin: ${origin})`;
  }
  const expected = new URL(origin).port || (new URL(origin).protocol === 'https:' ? '443' : '80');
  if (!LOOPBACK_HOSTS.has(host) || expected !== String(port)) {
    return `Cross-origin request rejected (Origin: ${origin})`;
  }
  return null;
}

/** Read a JSON request body, bounded so a stuck client cannot grow the heap. */
async function readJsonBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export function createViewerServer(data: ViewerData): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Everything except the one mutation route is GET/HEAD. Keeping the guard
    // route-scoped rather than dropping it means a new endpoint is read-only
    // unless someone deliberately adds it here.
    const isMutate = req.method === 'POST' && url.pathname === '/api/mutate';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isMutate) {
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendJson(res, 405, { error: 'Only GET and HEAD are allowed, except POST /api/mutate' });
      return;
    }

    try {
      if (isMutate) {
        // The live socket's port, not a captured one: `--port 0` picks the port
        // at listen time, so anything captured at construction would be 0.
        const denied = requireSameOrigin(req.headers, req.socket.localPort ?? 0);
        if (denied) {
          sendJson(res, 403, { error: denied });
          return;
        }
        // Requiring application/json is a second CSRF barrier, not politeness:
        // it is not a CORS "simple" content type, so a cross-origin attempt
        // needs a preflight this server never answers.
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          sendJson(res, 415, { error: 'Content-Type: application/json required' });
          return;
        }

        let body: { name?: unknown; args?: unknown };
        try {
          body = (await readJsonBody(req)) as { name?: unknown; args?: unknown };
        } catch (err) {
          sendJson(res, 400, { error: `Bad body: ${(err as Error).message}` });
          return;
        }
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) {
          sendJson(res, 400, { error: 'name required' });
          return;
        }
        const args = body.args;
        if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
          sendJson(res, 400, { error: 'args must be a JSON object' });
          return;
        }
        try {
          // Allowlist before anything that touches the network: a denied tool
          // must answer 403 whether or not an MCP server is reachable.
          if (!MUTATION_TOOLS.has(name)) throw new ToolNotAllowedError(name);
          // The tree on screen and the store that takes the write must be the
          // same file. TIM_MCP_PORT can point at a server for an entirely
          // different database, and without this an edit would land there while
          // the viewer showed no change at all.
          await assertSameDatabase(data.stats().databasePath);
          const text = await callMutationTool(name, (args ?? {}) as Record<string, unknown>);
          sendJson(res, 200, { text });
        } catch (err) {
          const kind = (err as Error).name;
          const status =
            kind === 'ToolNotAllowedError' ? 403 : kind === 'DatabaseMismatchError' ? 409 : 502;
          sendJson(res, status, { error: (err as Error).message });
        }
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        sendHtml(res, 200, VIEWER_PAGE);
        return;
      }

      if (url.pathname === '/api/stats') {
        sendJson(res, 200, data.stats());
        return;
      }

      if (url.pathname === '/api/projects') {
        sendJson(res, 200, { projects: data.listProjects(), otherRoots: data.otherRoots() });
        return;
      }

      if (url.pathname === '/api/children') {
        const id = url.searchParams.get('id');
        if (!id) {
          sendJson(res, 400, { error: 'id required' });
          return;
        }
        const result = data.children(id, {
          includeHidden: url.searchParams.get('hidden') === '1',
        });
        if (!result) {
          sendJson(res, 404, { error: `No entry with id or label "${id}"` });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === '/api/node') {
        const id = url.searchParams.get('id');
        if (!id) {
          sendJson(res, 400, { error: 'id required' });
          return;
        }
        const node = data.node(id);
        if (!node) {
          sendJson(res, 404, { error: `No entry with id or label "${id}"` });
          return;
        }
        sendJson(res, 200, { node });
        return;
      }

      if (url.pathname === '/api/tools') {
        sendJson(res, 200, { tools: listInspectorTools() });
        return;
      }

      // GET, not POST: the browser cannot reach the MCP server directly (other
      // origin, and giving that server CORS headers would expose its *write*
      // tools to any page the user has open), so the viewer proxies. Keeping it
      // a GET is what lets the method guard above stay literally true.
      if (url.pathname === '/api/tool') {
        const name = url.searchParams.get('name');
        if (!name) {
          sendJson(res, 400, { error: 'name required' });
          return;
        }
        let args: Record<string, unknown>;
        try {
          const raw = url.searchParams.get('args');
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('args must be a JSON object');
          }
          args = parsed as Record<string, unknown>;
        } catch (err) {
          sendJson(res, 400, { error: `Bad args: ${(err as Error).message}` });
          return;
        }
        try {
          sendJson(res, 200, { text: await callInspectorTool(name, args) });
        } catch (err) {
          // 403 for "not on the allowlist", 502 for "the server did not answer":
          // the panel tells them apart, and only one of them is the user's doing.
          const denied = (err as Error).name === 'ToolNotAllowedError';
          sendJson(res, denied ? 403 : 502, { error: (err as Error).message });
        }
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

export async function startViewer(options: ViewerServerOptions): Promise<ViewerHandle> {
  const host = options.host ?? '127.0.0.1';
  // Checked before anything is opened or bound — a bad host must not even
  // reach the database.
  assertLoopbackHost(host);

  const data = ViewerData.open(options.dbPath, { showSecrets: options.showSecrets === true });
  const server = createViewerServer(data);

  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      data.close();
      reject(err);
    };
    server.once('error', onError);
    server.listen(options.port ?? 7373, host, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : (options.port ?? 7373);
      const displayHost = host === '::1' || host === '[::1]' ? '[::1]' : host;
      resolve({
        server,
        data,
        port,
        host,
        url: `http://${displayHost}:${port}/`,
        close: () =>
          new Promise<void>((done, fail) => {
            // Browsers hold keep-alive sockets open; without this Ctrl-C
            // would wait for them to idle out before the server closes.
            server.closeAllConnections();
            server.close(err => {
              data.close();
              if (err) fail(err);
              else done();
            });
          }),
      });
    });
  });
}
