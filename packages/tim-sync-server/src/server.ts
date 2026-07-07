import http from 'node:http';
import { TenantRegistry } from './tenant-registry.js';
import { createFile, listFiles, pushBlobs, pullBlobs } from './storage.js';
import type { TenantTier } from './quotas.js';

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const REGISTER_RATE_LIMIT = 5;
export const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface HostedServerOptions {
  port?: number;
  dataDir: string;
  adminToken?: string;
}

export interface HostedServerHandle {
  server: http.Server;
  registry: TenantRegistry;
  port: number;
  startedAt: number;
  close: () => Promise<void>;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

export function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > maxBytes) {
        rejected = true;
        req.on('data', () => {});
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export class RegisterRateLimiter {
  private attempts = new Map<string, number[]>();

  isLimited(ip: string, now = Date.now()): boolean {
    const windowStart = now - REGISTER_RATE_WINDOW_MS;
    const recent = (this.attempts.get(ip) ?? []).filter(t => t > windowStart);
    if (recent.length >= REGISTER_RATE_LIMIT) {
      this.attempts.set(ip, recent);
      return true;
    }
    recent.push(now);
    this.attempts.set(ip, recent);
    return false;
  }

  reset(): void {
    this.attempts.clear();
  }
}

function isAdminToken(provided: string, expected?: string): boolean {
  return Boolean(expected && provided && provided === expected);
}

export function createHostedSyncServer(
  options: HostedServerOptions,
  rateLimiter: RegisterRateLimiter = new RegisterRateLimiter(),
): HostedServerHandle {
  const registry = new TenantRegistry(options.dataDir);
  const startedAt = Date.now();
  const adminToken = options.adminToken ?? process.env.TIM_SYNC_ADMIN_TOKEN;

  const server = http.createServer(async (req, res) => {
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
      } else {
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
        if (raw) JSON.parse(raw);
        const tenant = registry.register('free');
        sendJson(res, 201, {
          token: tenant.token,
          tenant_id: tenant.id,
          tier: tenant.tier,
        });
      } catch (e) {
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
        const parsed = JSON.parse(raw) as { tenant_id?: string; tier?: TenantTier };
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
      } catch (e) {
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
      const files = listFiles(registry, tenant.id);
      sendJson(res, 200, { files });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/files') {
      try {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw) as { id: string; salt: string };
        const result = createFile(registry, tenant.id, parsed.id, parsed.salt);
        if ('conflict' in result) {
          sendJson(res, 409, { error: 'File already exists' });
          return;
        }
        sendJson(res, 200, result);
      } catch (e) {
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
        const parsed = JSON.parse(raw) as {
          file_id: string;
          idempotency_key: string;
          blobs: { proposed_id: string; data: string; device_id: string; updated_at: string }[];
        };
        const result = pushBlobs(
          registry,
          tenant.id,
          tenant.tier,
          parsed.file_id,
          parsed.idempotency_key,
          parsed.blobs ?? [],
        );
        if ('error' in result) {
          sendJson(res, result.status, { error: result.error });
          return;
        }
        sendJson(res, 200, result);
      } catch (e) {
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
      const result = pullBlobs(registry, tenant.id, fileId, cursor);
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

export function startHostedSyncServer(options: HostedServerOptions): Promise<HostedServerHandle> {
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
