import { randomUUID } from 'node:crypto';
import { parseGenerationCursor } from 'tim-core';
export interface SyncCallOptions {
  deadlineAt?: number;
}

export const PERMANENT_SYNC_CODES = new Set(['UNAUTHORIZED', 'REVOKED', 'PAYMENT_REQUIRED']);

export class SyncApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SyncApiError';
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), 120_000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, Math.min(when - now, 120_000));
  return undefined;
}

function failureFromResult(status: number, error: string, retryAfterMs?: number): SyncApiError {
  if (status === 401) return new SyncApiError(error || 'Unauthorized', 'UNAUTHORIZED', status);
  if (status === 402) return new SyncApiError(error || 'Subscription required', 'PAYMENT_REQUIRED', status);
  if (status === 403) return new SyncApiError(error || 'Access revoked', 'REVOKED', status);
  if (status === 409) return new SyncApiError(error || 'Conflict', 'CONFLICT', status);
  if (status === 429) return new SyncApiError(error || 'Too many requests', 'RATE_LIMITED', status, retryAfterMs);
  if (status === 0 && /deadline/i.test(error)) return new SyncApiError(error || 'Deadline exceeded', 'DEADLINE');
  if (status === 0 && /timeout|aborted/i.test(error)) {
    return new SyncApiError(error || 'Timeout', 'TIMEOUT', 0);
  }
  if (status === 0) return new SyncApiError(error || 'Network error', 'NETWORK', 0);
  return new SyncApiError(error || 'Request failed', 'HTTP_ERROR', status);
}

type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; retryAfterMs?: number };

export interface PushBlob {
  entity_type?: 'entry' | 'edge';
  entity_key?: string;
  lww_device?: string;
  proposed_id: string;
  data: string;
  device_id: string;
  updated_at: string;
}

export interface PushRequest {
  protocol_generation?: number;
  file_generation?: string;
  file_id: string;
  idempotency_key: string;
  client_schema_major: number;
  blobs: PushBlob[];
}

export interface PushResponse {
  mappings: { proposed_id: string; final_id: number }[];
}

export interface PullBlob extends Omit<PushBlob, 'proposed_id'> {
  received_at: string;
  id: number;
  client_proposed_id?: string;
  data: string;
  deleted_at?: string | null;
  updated_at: string;
}

export interface PullResponse {
  generation: string;
  protocol_generation: number;
  blobs: PullBlob[];
  server_time: string;
  salt?: string;
  has_more: boolean;
  next_cursor: string;
}

export interface TimFile {
  generation: string;
  id: string;
  salt?: string;
}

export class TimSyncClient {
  private readonly deviceId = randomUUID();
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options?: SyncCallOptions,
  ): Promise<ApiResult<T>> {
    const deadlineAt = options?.deadlineAt;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      return { ok: false, status: 0, error: 'deadline exceeded' };
    }
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> ?? {}),
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }
      const signals: AbortSignal[] = [];
      if (init.signal) signals.push(init.signal);
      if (deadlineAt !== undefined) {
        signals.push(AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())));
      }
      const signal = signals.length === 0 ? undefined
        : signals.length === 1 ? signals[0]
        : AbortSignal.any(signals);
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal });
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const data = await res.json();
      if (!res.ok) {
        const d = data as { error?: string; details?: unknown };
        const detail = d.details ? ` | ${JSON.stringify(d.details).slice(0, 200)}` : '';
        return {
          ok: false,
          status: res.status,
          error: (d.error ?? 'Unknown error') + detail,
          retryAfterMs,
        };
      }
      if ((data as { protocol_generation?: unknown })?.protocol_generation !== 1) {
        throw new SyncApiError('Unsupported server protocol generation', 'PROTOCOL_MISMATCH', 409);
      }
      return { ok: true, data: data as T };
    } catch (e) {
      if (e instanceof SyncApiError) throw e;
      const err = e as Error;
      const timedOut = err.name === 'TimeoutError'
        || err.name === 'AbortError'
        || /timeout|aborted/i.test(err.message ?? '');
      const message = err.message || 'Network error';
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        return { ok: false, status: 0, error: `deadline exceeded: ${message}` };
      }
      return { ok: false, status: 0, error: timedOut ? `timeout: ${message}` : message };
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async healthDetails(): Promise<Record<string, unknown> | null> {
    const r = await this.request<Record<string, unknown>>('/health');
    return r.ok ? r.data : null;
  }

  async register(tier: 'free' | 'pro' = 'free'): Promise<{ token: string; tenant_id: string; tier: string }> {
    const r = await this.request<{ token: string; tenant_id: string; tier: string }>('/register', {
      method: 'POST',
      body: JSON.stringify({ tier }),
    });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  async syncStatus(): Promise<{ tier: string; entry_count: number; total_bytes: number }> {
    const r = await this.request<{ tier: string; entry_count: number; total_bytes: number }>('/sync/status');
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  async listFiles(options?: SyncCallOptions): Promise<TimFile[]> {
    const r = await this.request<{ files: TimFile[] }>('/files', {}, options);
    if (!r.ok) throw failureFromResult(r.status, r.error, r.retryAfterMs);
    return r.data.files;
  }

  async createFile(id: string, salt: string): Promise<TimFile> {
    const r = await this.request<TimFile>('/files', {
      method: 'POST',
      body: JSON.stringify({ id, owner_type: 'personal', salt }),
    });
    if (!r.ok) {
      if (r.status === 409) throw new SyncApiError('File already exists', 'CONFLICT');
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
      throw new Error(r.error);
    }
    return r.data;
  }

  async fileGeneration(fileId: string, options?: SyncCallOptions): Promise<string> {
    const file = (await this.listFiles(options)).find(f => f.id === fileId);
    if (!file || typeof file.generation !== 'string' || !file.generation) throw new SyncApiError('Missing file generation', 'PROTOCOL_MISMATCH');
    return file.generation;
  }

  async push(req: PushRequest, options?: SyncCallOptions): Promise<PushResponse> {
    const generation = req.file_generation ?? await this.fileGeneration(req.file_id, options);
    const r = await this.request<PushResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify({ ...req, file_generation: generation, protocol_generation: req.protocol_generation ?? 1 }),
    }, options);
    if (!r.ok) {
      if (r.status === 403) throw new SyncApiError('Access revoked', 'REVOKED', 403);
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED', 402);
      throw failureFromResult(r.status, r.error, r.retryAfterMs);
    }
    return r.data;
  }

  async pull(fileId: string, cursor?: string, clientSchemaMajor = 1, generation?: string, deviceId: string = this.deviceId, options?: SyncCallOptions): Promise<PullResponse> {
    generation ??= await this.fileGeneration(fileId, options);
    const params = [`file_id=${encodeURIComponent(fileId)}`];
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    params.push(`client_schema_major=${clientSchemaMajor}`, `protocol_generation=1`,
      `file_generation=${encodeURIComponent(generation)}`, `device_id=${encodeURIComponent(deviceId)}`);
    const r = await this.request<PullResponse>(`/sync/pull?${params.join('&')}`, {}, options);
    if (!r.ok) {
      if (r.status === 403) throw new SyncApiError('Access revoked', 'REVOKED', 403);
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED', 402);
      throw failureFromResult(r.status, r.error, r.retryAfterMs);
    }
    if (r.data.generation !== generation || r.data.protocol_generation !== 1) throw new SyncApiError('File or protocol generation mismatch', 'PROTOCOL_MISMATCH');
    const id = parseGenerationCursor(r.data.next_cursor,generation);
    const before = cursor ? parseGenerationCursor(cursor,generation) : 0;
    if (!Array.isArray(r.data.blobs) || typeof r.data.has_more !== 'boolean') throw new SyncApiError('Malformed pull response','PROTOCOL_MISMATCH');
    let previous = before;
    for (const blob of r.data.blobs) {
      if (!Number.isSafeInteger(blob.id) || blob.id <= previous || blob.id > id) throw new SyncApiError('Invalid blob cursor ordering','PROTOCOL_MISMATCH');
      previous = blob.id;
    }
    if (id !== previous || (r.data.has_more && id === before)) throw new SyncApiError('Invalid cursor progression', 'PROTOCOL_MISMATCH');
    return r.data;
  }
  async ack(fileId: string, generation: string, deviceId: string, cursor: string, options?: SyncCallOptions): Promise<void> {
    const r = await this.request<{ generation: string; cursor: string }>('/sync/ack', {
      method: 'POST', body: JSON.stringify({ file_id: fileId, file_generation: generation,
        device_id: deviceId, cursor, client_schema_major: 1, protocol_generation: 1 }),
    }, options);
    if (!r.ok) throw failureFromResult(r.status, r.error, r.retryAfterMs);
    if (r.data.generation !== generation) throw new SyncApiError('ACK generation mismatch','PROTOCOL_MISMATCH');
  }

}
