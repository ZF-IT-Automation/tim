"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegisterRateLimiter = exports.BodyTooLargeError = exports.REGISTER_RATE_WINDOW_MS = exports.REGISTER_RATE_LIMIT = exports.MAX_BODY_BYTES = void 0;
exports.readBody = readBody;
exports.createHostedSyncServer = createHostedSyncServer;
exports.startHostedSyncServer = startHostedSyncServer;
const node_http_1 = __importDefault(require("node:http"));
const tenant_registry_js_1 = require("./tenant-registry.js");
const storage_js_1 = require("./storage.js");
exports.MAX_BODY_BYTES = 10 * 1024 * 1024;
exports.REGISTER_RATE_LIMIT = 5;
exports.REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000;
class BodyTooLargeError extends Error {
    constructor() {
        super('Request body too large');
        this.name = 'BodyTooLargeError';
    }
}
exports.BodyTooLargeError = BodyTooLargeError;
function readBody(req, maxBytes = exports.MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let rejected = false;
        req.on('data', (c) => {
            if (rejected)
                return;
            total += c.length;
            if (total > maxBytes) {
                rejected = true;
                req.on('data', () => { });
                reject(new BodyTooLargeError());
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!rejected)
                resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', reject);
    });
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
}
class RegisterRateLimiter {
    attempts = new Map();
    isLimited(ip, now = Date.now()) {
        const windowStart = now - exports.REGISTER_RATE_WINDOW_MS;
        const recent = (this.attempts.get(ip) ?? []).filter(t => t > windowStart);
        if (recent.length >= exports.REGISTER_RATE_LIMIT) {
            this.attempts.set(ip, recent);
            return true;
        }
        recent.push(now);
        this.attempts.set(ip, recent);
        return false;
    }
    reset() {
        this.attempts.clear();
    }
}
exports.RegisterRateLimiter = RegisterRateLimiter;
function isAdminToken(provided, expected) {
    return Boolean(expected && provided && provided === expected);
}
function createHostedSyncServer(options, rateLimiter = new RegisterRateLimiter()) {
    const registry = new tenant_registry_js_1.TenantRegistry(options.dataDir);
    const startedAt = Date.now();
    const adminToken = options.adminToken ?? process.env.TIM_SYNC_ADMIN_TOKEN;
    const server = node_http_1.default.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const authHeader = req.headers.authorization ?? '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (req.method === 'GET' && url.pathname === '/health') {
            const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
            if (isAdminToken(token, adminToken)) {
                const stats = registry.aggregateStats();
                sendJson(res, 200, {
                    ok: true,
                    uptime_sec: uptimeSec,
                    tenant_count: stats.tenantCount,
                    total_entries: stats.totalEntries,
                    total_bytes: stats.totalBytes,
                });
            }
            else {
                sendJson(res, 200, { ok: true, uptime_sec: uptimeSec });
            }
            return;
        }
        if (req.method === 'POST' && url.pathname === '/register') {
            const ip = clientIp(req);
            if (rateLimiter.isLimited(ip)) {
                sendJson(res, 429, { error: 'Registration rate limit exceeded (max 5 per hour)' });
                return;
            }
            try {
                const raw = await readBody(req);
                if (raw)
                    JSON.parse(raw);
                const tenant = registry.register('free');
                sendJson(res, 201, {
                    token: tenant.token,
                    tenant_id: tenant.id,
                    tier: tenant.tier,
                });
            }
            catch (e) {
                if (e instanceof BodyTooLargeError) {
                    sendJson(res, 413, { error: 'Request body too large' });
                    return;
                }
                sendJson(res, 400, { error: 'Invalid JSON body' });
            }
            return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/promote') {
            if (!isAdminToken(token, adminToken)) {
                sendJson(res, 401, { error: 'Admin authorization required' });
                return;
            }
            try {
                const raw = await readBody(req);
                const parsed = JSON.parse(raw);
                if (!parsed.tenant_id || parsed.tier !== 'pro') {
                    sendJson(res, 400, { error: 'tenant_id and tier=pro required' });
                    return;
                }
                const ok = registry.setTenantTier(parsed.tenant_id, 'pro');
                if (!ok) {
                    sendJson(res, 404, { error: 'Tenant not found' });
                    return;
                }
                sendJson(res, 200, { tenant_id: parsed.tenant_id, tier: 'pro' });
            }
            catch (e) {
                if (e instanceof BodyTooLargeError) {
                    sendJson(res, 413, { error: 'Request body too large' });
                    return;
                }
                sendJson(res, 400, { error: 'Invalid request' });
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
            catch (e) {
                if (e instanceof BodyTooLargeError) {
                    sendJson(res, 413, { error: 'Request body too large' });
                    return;
                }
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
            catch (e) {
                if (e instanceof BodyTooLargeError) {
                    sendJson(res, 413, { error: 'Request body too large' });
                    return;
                }
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