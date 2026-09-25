/**
 * Minimal o9k-sync-compatible dev server for local testing (no auth).
 */

import http from 'node:http';
import { SYNC_CAPABILITIES, validProtocolVersion, parseGenerationCursor } from 'tim-core';
import type { PushBlob } from './client.js';
import { randomUUID } from 'node:crypto';

interface StoredBlob extends PushBlob {
  received_at: string;
  id: number;
  client_proposed_id: string;
  data: string;
  device_id: string;
  updated_at: string;
  deleted_at: string | null;
}

interface FileRecord {
  generation: string;
  id: string;
  salt: string;
  blobs: StoredBlob[];
  nextId: number;
  cursorSeq: number;
}

const files = new Map<string, FileRecord>();
const idempotency = new Map<string, { hash: string; mappings: { proposed_id: string; final_id: number }[] }>();

export function startDevServer(port = 3100): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...SYNC_CAPABILITIES, ...(body as object) }));
    };

    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      send(200, {
        files: [...files.values()].map((f) => ({ id: f.id, salt: f.salt, generation: f.generation })),
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
          generation: randomUUID(),
          id: parsed.id,
          salt: parsed.salt,
          blobs: [],
          nextId: 1,
          cursorSeq: 0,
        });
        send(200, { id: parsed.id, salt: parsed.salt, generation: files.get(parsed.id)!.generation });
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sync/push') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          file_generation: string;
          file_id: string;
          idempotency_key: string;
          blobs: PushBlob[];
        };
        const file = files.get(parsed.file_id);
        if (!file) {
          send(404, { error: 'File not found' });
          return;
        }
        if (!validProtocolVersion(parsed) || parsed.file_generation !== file.generation) { send(409, { error: 'Generation mismatch' }); return; }
        const hash = JSON.stringify(parsed);
        const seen = idempotency.get(parsed.idempotency_key);
        if (seen) { send(seen.hash === hash ? 200 : 409, seen.hash === hash ? { mappings: seen.mappings } : { error: 'Idempotency mismatch' }); return; }
        const mappings: { proposed_id: string; final_id: number }[] = [];
        for (const b of parsed.blobs) {
          const id = file.nextId++;
          file.blobs.push({ ...b,id,client_proposed_id: b.proposed_id,deleted_at: null,received_at: new Date().toISOString() });
          mappings.push({ proposed_id: b.proposed_id, final_id: id });
        }
        idempotency.set(parsed.idempotency_key,{ hash,mappings });
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
      if (url.searchParams.get('file_generation') !== file.generation) { send(409, { error: 'Generation mismatch' }); return; }
      let startIdx: number;
      try { startIdx = cursor ? parseGenerationCursor(cursor,file.generation) : 0; } catch { send(409,{ error: 'Invalid cursor' }); return; }
      const slice = file.blobs.slice(startIdx);
      const hasMore = false;
      const nextCursor = `${file.generation}|${file.blobs.length}`;
      send(200, {
        generation: file.generation,
        blobs: slice,
        server_time: new Date().toISOString(),
        salt: file.salt,
        has_more: hasMore,
        next_cursor: nextCursor,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sync/ack') {
      let body = ''; req.on('data', c => { body += c; });
      req.on('end', () => { const p = JSON.parse(body); send(200,{ generation: p.file_generation,cursor: p.cursor }); });
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
  files.set(id, { generation: randomUUID(), id, salt, blobs: [], nextId: 1, cursorSeq: 0 });
}
