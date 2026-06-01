/**
 * Minimal o9k-sync-compatible dev server for local testing (no auth).
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

interface StoredBlob {
  id: number;
  client_proposed_id: string;
  data: string;
  device_id: string;
  updated_at: string;
  deleted_at: string | null;
}

interface FileRecord {
  id: string;
  salt: string;
  blobs: StoredBlob[];
  nextId: number;
  cursorSeq: number;
}

const files = new Map<string, FileRecord>();
const idempotency = new Map<string, number>();

export function startDevServer(port = 3100): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      send(200, {
        files: [...files.values()].map((f) => ({ id: f.id, salt: f.salt })),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/files') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: string; salt: string };
        if (files.has(parsed.id)) {
          send(409, { error: 'File already exists' });
          return;
        }
        files.set(parsed.id, {
          id: parsed.id,
          salt: parsed.salt,
          blobs: [],
          nextId: 1,
          cursorSeq: 0,
        });
        send(200, { id: parsed.id, salt: parsed.salt });
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sync/push') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          file_id: string;
          idempotency_key: string;
          blobs: { proposed_id: string; data: string; device_id: string; updated_at: string }[];
        };
        const file = files.get(parsed.file_id);
        if (!file) {
          send(404, { error: 'File not found' });
          return;
        }
        if (idempotency.has(parsed.idempotency_key)) {
          send(200, { mappings: [] });
          return;
        }
        idempotency.set(parsed.idempotency_key, 1);
        const mappings: { proposed_id: string; final_id: number }[] = [];
        for (const b of parsed.blobs) {
          const existing = file.blobs.find((x) => x.client_proposed_id === b.proposed_id);
          if (existing) {
            existing.data = b.data;
            existing.updated_at = b.updated_at;
            mappings.push({ proposed_id: b.proposed_id, final_id: existing.id });
          } else {
            const id = file.nextId++;
            file.blobs.push({
              id,
              client_proposed_id: b.proposed_id,
              data: b.data,
              device_id: b.device_id,
              updated_at: b.updated_at,
              deleted_at: null,
            });
            mappings.push({ proposed_id: b.proposed_id, final_id: id });
          }
        }
        send(200, { mappings });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sync/pull') {
      const fileId = url.searchParams.get('file_id');
      const cursor = url.searchParams.get('cursor');
      const file = fileId ? files.get(fileId) : undefined;
      if (!file) {
        send(404, { error: 'File not found' });
        return;
      }
      const startIdx = cursor ? parseInt(cursor, 10) : 0;
      const slice = file.blobs.slice(startIdx);
      const hasMore = false;
      const nextCursor = String(file.blobs.length);
      send(200, {
        blobs: slice.map((b) => ({
          id: b.id,
          client_proposed_id: b.client_proposed_id,
          data: b.data,
          deleted_at: b.deleted_at,
          updated_at: b.updated_at,
        })),
        server_time: new Date().toISOString(),
        salt: file.salt,
        has_more: hasMore,
        next_cursor: nextCursor,
      });
      return;
    }

    send(404, { error: 'Not found' });
  });

  server.listen(port, () => {
    console.log(`Dev sync server running on http://localhost:${port}`);
  });

  return server;
}

export function resetDevServer(): void {
  files.clear();
  idempotency.clear();
}

/** @internal test helper */
export function seedDevFile(id: string, salt: string): void {
  files.set(id, { id, salt, blobs: [], nextId: 1, cursorSeq: 0 });
}
