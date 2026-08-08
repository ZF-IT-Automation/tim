"use strict";
// `tim viewer` HTTP server — plain node:http, same idiom as tim-sync-server.
//
// Read-only, with one honest qualifier. The store handle is opened readonly and
// the router answers GET/HEAD only, so nothing served from this process can
// mutate the database. /api/tool is the exception worth naming: it forwards to
// the MCP server, which holds a writable store. It is confined to the allowlist
// in viewer-tools.ts, whose members change no memory — but they do touch
// accessed_at and usage telemetry, so the guarantee is "no memory changes",
// not "no bytes written".
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NonLoopbackBindError = exports.LOOPBACK_HOSTS = void 0;
exports.assertLoopbackHost = assertLoopbackHost;
exports.createViewerServer = createViewerServer;
exports.startViewer = startViewer;
const node_http_1 = __importDefault(require("node:http"));
const viewer_data_js_1 = require("./viewer-data.js");
const viewer_page_js_1 = require("./viewer-page.js");
const viewer_tools_js_1 = require("./viewer-tools.js");
/** Hosts that resolve to the loopback interface. Nothing else may bind. */
exports.LOOPBACK_HOSTS = new Set([
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
]);
class NonLoopbackBindError extends Error {
    host;
    constructor(host) {
        super(`Refusing to bind tim viewer to "${host}" — the viewer serves private memory ` +
            'unauthenticated and may only listen on loopback (127.0.0.1, ::1, localhost).');
        this.name = 'NonLoopbackBindError';
        this.host = host;
    }
}
exports.NonLoopbackBindError = NonLoopbackBindError;
function assertLoopbackHost(host) {
    if (!exports.LOOPBACK_HOSTS.has(host))
        throw new NonLoopbackBindError(host);
}
function sendJson(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
}
function sendHtml(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // The page is fully inlined; forbid any outbound fetch so an injected
        // string in stored memory can never phone home.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(body);
}
function createViewerServer(data) {
    return node_http_1.default.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        // Read-only guarantee at the HTTP layer: no verb other than GET/HEAD
        // reaches a handler, so there is no mutating endpoint to reach.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            sendJson(res, 405, { error: 'Read-only viewer: only GET and HEAD are allowed' });
            return;
        }
        try {
            if (url.pathname === '/' || url.pathname === '/index.html') {
                sendHtml(res, 200, viewer_page_js_1.VIEWER_PAGE);
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
                sendJson(res, 200, { tools: (0, viewer_tools_js_1.listInspectorTools)() });
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
                let args;
                try {
                    const raw = url.searchParams.get('args');
                    const parsed = raw ? JSON.parse(raw) : {};
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                        throw new Error('args must be a JSON object');
                    }
                    args = parsed;
                }
                catch (err) {
                    sendJson(res, 400, { error: `Bad args: ${err.message}` });
                    return;
                }
                try {
                    sendJson(res, 200, { text: await (0, viewer_tools_js_1.callInspectorTool)(name, args) });
                }
                catch (err) {
                    // 403 for "not on the allowlist", 502 for "the server did not answer":
                    // the panel tells them apart, and only one of them is the user's doing.
                    const denied = err.name === 'ToolNotAllowedError';
                    sendJson(res, denied ? 403 : 502, { error: err.message });
                }
                return;
            }
            sendJson(res, 404, { error: 'Not found' });
        }
        catch (err) {
            sendJson(res, 500, { error: err.message });
        }
    });
}
async function startViewer(options) {
    const host = options.host ?? '127.0.0.1';
    // Checked before anything is opened or bound — a bad host must not even
    // reach the database.
    assertLoopbackHost(host);
    const data = viewer_data_js_1.ViewerData.open(options.dbPath, { showSecrets: options.showSecrets === true });
    const server = createViewerServer(data);
    return new Promise((resolve, reject) => {
        const onError = (err) => {
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
                close: () => new Promise((done, fail) => {
                    // Browsers hold keep-alive sockets open; without this Ctrl-C
                    // would wait for them to idle out before the server closes.
                    server.closeAllConnections();
                    server.close(err => {
                        data.close();
                        if (err)
                            fail(err);
                        else
                            done();
                    });
                }),
            });
        });
    });
}
//# sourceMappingURL=viewer-server.js.map