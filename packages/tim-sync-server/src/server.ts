import http from 'node:http';
import { TenantRegistry } from './tenant-registry.js';
import { createFile, listFiles, pushBlobs, pullBlobs } from './storage.js';
import type { TenantTier } from './quotas.js';

export interface HostedServerOptions {
  port?: number;
  dataDir: string;
}

export interface HostedServerHandle {
  server: http.Server;
  registry: TenantRegistry;
  port: number;
  startedAt: number;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createHostedSyncServer(options: HostedServerOptions): HostedServerHandle {
  const registry = new TenantRegistry(options.dataDir);
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
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
        const parsed = raw ? JSON.parse(raw) as { tier?: TenantTier } : {};
        const tier = parsed.tier === 'pro' ? 'pro' : 'free';
        const tenant = registry.register(tier);
        sendJson(res, 201, {
          token: tenant.token,
          tenant_id: tenant.id,
          tier: tenant.tier,
        });
      } catch {
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
      } catch {
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
      } catch {
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
