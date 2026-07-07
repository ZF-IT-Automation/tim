"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHostedSyncServer = createHostedSyncServer;
exports.startHostedSyncServer = startHostedSyncServer;
const node_http_1 = __importDefault(require("node:http"));
const tenant_registry_js_1 = require("./tenant-registry.js");
const storage_js_1 = require("./storage.js");
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
function createHostedSyncServer(options) {
    const registry = new tenant_registry_js_1.TenantRegistry(options.dataDir);
    const startedAt = Date.now();
    const server = node_http_1.default.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (req.method === 'GET' && url.pathname === '/health') {
            const stats = registry.aggregateStats();
            sendJson(res, 200, {
                ok: true,
                uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
                tenant_count: stats.tenantCount,
                total_entries: stats.totalEntries,
                total_bytes: stats.totalBytes,
            });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/register') {
            try {
                const raw = await readBody(req);
                const parsed = raw ? JSON.parse(raw) : {};
                const tier = parsed.tier === 'pro' ? 'pro' : 'free';
                const tenant = registry.register(tier);
                sendJson(res, 201, {
                    token: tenant.token,
                    tenant_id: tenant.id,
                    tier: tenant.tier,
                });
            }
            catch {
                sendJson(res, 400, { error: 'Invalid JSON body' });
            }
            return;
        }
        const tenant = token ? registry.resolveToken(token) : null;
        if (!tenant) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/files') {
            const files = (0, storage_js_1.listFiles)(registry, tenant.id);
            sendJson(res, 200, { files });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/files') {
            try {
                const raw = await readBody(req);
                const parsed = JSON.parse(raw);
                const result = (0, storage_js_1.createFile)(registry, tenant.id, parsed.id, parsed.salt);
                if ('conflict' in result) {
                    sendJson(res, 409, { error: 'File already exists' });
                    return;
                }
                sendJson(res, 200, result);
            }
            catch {
                sendJson(res, 400, { error: 'Invalid request' });
            }
            return;
        }
        if (req.method === 'POST' && url.pathname === '/sync/push') {
            try {
                const raw = await readBody(req);
                const parsed = JSON.parse(raw);
                const result = (0, storage_js_1.pushBlobs)(registry, tenant.id, tenant.tier, parsed.file_id, parsed.idempotency_key, parsed.blobs ?? []);
                if ('error' in result) {
                    sendJson(res, result.status, { error: result.error });
                    return;
                }
                sendJson(res, 200, result);
            }
            catch {
                sendJson(res, 400, { error: 'Invalid request' });
            }
            return;
        }
        if (req.method === 'GET' && url.pathname === '/sync/pull') {
            const fileId = url.searchParams.get('file_id');
            if (!fileId) {
                sendJson(res, 400, { error: 'file_id required' });
                return;
            }
            const cursor = url.searchParams.get('cursor') ?? undefined;
            const result = (0, storage_js_1.pullBlobs)(registry, tenant.id, fileId, cursor);
            if ('error' in result) {
                sendJson(res, result.status, { error: result.error });
                return;
            }
            sendJson(res, 200, {
                ...result,
                server_time: new Date().toISOString(),
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/sync/status') {
            const usage = registry.getUsage(tenant.id);
            sendJson(res, 200, {
                tier: tenant.tier,
                entry_count: usage.entryCount,
                total_bytes: usage.totalBytes,
            });
            return;
        }
        sendJson(res, 404, { error: 'Not found' });
    });
    return {
        server,
        registry,
        port: options.port ?? 0,
        startedAt,
        close: () => new Promise((resolve, reject) => {
            registry.close();
            server.close(err => (err ? reject(err) : resolve()));
        }),
    };
}
function startHostedSyncServer(options) {
    const handle = createHostedSyncServer(options);
    return new Promise((resolve, reject) => {
        handle.server.listen(options.port ?? 3100, () => {
            const addr = handle.server.address();
            if (addr && typeof addr === 'object') {
                handle.port = addr.port;
            }
            resolve(handle);
        });
        handle.server.on('error', reject);
    });
}
//# sourceMappingURL=server.js.map