export class SyncApiError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'SyncApiError';
  }
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface PushBlob {
  proposed_id: string;
  data: string;
  device_id: string;
  updated_at: string;
}

export interface PushRequest {
  file_id: string;
  idempotency_key: string;
  client_schema_major: number;
  blobs: PushBlob[];
}

export interface PushResponse {
  mappings: { proposed_id: string; final_id: number }[];
}

export interface PullBlob {
  id: number;
  client_proposed_id?: string;
  data: string;
  deleted_at?: string | null;
  updated_at: string;
}

export interface PullResponse {
  blobs: PullBlob[];
  server_time: string;
  salt?: string;
  has_more: boolean;
  next_cursor: string;
}

export interface TimFile {
  id: string;
  salt?: string;
}

export class TimSyncClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> ?? {}),
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
      const data = await res.json();
      if (!res.ok) {
        const d = data as { error?: string; details?: unknown };
        const detail = d.details ? ` | ${JSON.stringify(d.details).slice(0, 200)}` : '';
        return { ok: false, status: res.status, error: (d.error ?? 'Unknown error') + detail };
      }
      return { ok: true, data: data as T };
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message };
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

  async listFiles(): Promise<TimFile[]> {
    const r = await this.request<{ files: TimFile[] }>('/files');
    if (!r.ok) {
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
      throw new Error(r.error);
    }
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

  async push(req: PushRequest): Promise<PushResponse> {
    const r = await this.request<PushResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    if (!r.ok) {
      if (r.status === 403) throw new SyncApiError('Access revoked', 'REVOKED');
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
      throw new Error(r.error);
    }
    return r.data;
  }

  async pull(fileId: string, cursor?: string, clientSchemaMajor = 1): Promise<PullResponse> {
    const params = [`file_id=${encodeURIComponent(fileId)}`];
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    params.push(`client_schema_major=${clientSchemaMajor}`);
    const r = await this.request<PullResponse>(`/sync/pull?${params.join('&')}`);
    if (!r.ok) {
      if (r.status === 403) throw new SyncApiError('Access revoked', 'REVOKED');
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
      throw new Error(r.error);
    }
    return r.data;
  }
}
