"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimSyncClient = exports.SyncApiError = void 0;
class SyncApiError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'SyncApiError';
    }
}
exports.SyncApiError = SyncApiError;
class TimSyncClient {
    baseUrl;
    apiKey;
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }
    async request(path, init = {}) {
        try {
            const headers = {
                'Content-Type': 'application/json',
                ...(init.headers ?? {}),
            };
            if (this.apiKey) {
                headers.Authorization = `Bearer ${this.apiKey}`;
            }
            const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
            const data = await res.json();
            if (!res.ok) {
                const d = data;
                const detail = d.details ? ` | ${JSON.stringify(d.details).slice(0, 200)}` : '';
                return { ok: false, status: res.status, error: (d.error ?? 'Unknown error') + detail };
            }
            return { ok: true, data: data };
        }
        catch (e) {
            return { ok: false, status: 0, error: e.message };
        }
    }
    async health() {
        try {
            const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async healthDetails() {
        const r = await this.request('/health');
        return r.ok ? r.data : null;
    }
    async register(tier = 'free') {
        const r = await this.request('/register', {
            method: 'POST',
            body: JSON.stringify({ tier }),
        });
        if (!r.ok)
            throw new Error(r.error);
        return r.data;
    }
    async syncStatus() {
        const r = await this.request('/sync/status');
        if (!r.ok)
            throw new Error(r.error);
        return r.data;
    }
    async listFiles() {
        const r = await this.request('/files');
        if (!r.ok) {
            if (r.status === 402)
                throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
            throw new Error(r.error);
        }
        return r.data.files;
    }
    async createFile(id, salt) {
        const r = await this.request('/files', {
            method: 'POST',
            body: JSON.stringify({ id, owner_type: 'personal', salt }),
        });
        if (!r.ok) {
            if (r.status === 409)
                throw new SyncApiError('File already exists', 'CONFLICT');
            if (r.status === 402)
                throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
            throw new Error(r.error);
        }
        return r.data;
    }
    async push(req) {
        const r = await this.request('/sync/push', {
            method: 'POST',
            body: JSON.stringify(req),
        });
        if (!r.ok) {
            if (r.status === 403)
                throw new SyncApiError('Access revoked', 'REVOKED');
            if (r.status === 402)
                throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
            throw new Error(r.error);
        }
        return r.data;
    }
    async pull(fileId, cursor, clientSchemaMajor = 1) {
        const params = [`file_id=${encodeURIComponent(fileId)}`];
        if (cursor)
            params.push(`cursor=${encodeURIComponent(cursor)}`);
        params.push(`client_schema_major=${clientSchemaMajor}`);
        const r = await this.request(`/sync/pull?${params.join('&')}`);
        if (!r.ok) {
            if (r.status === 403)
                throw new SyncApiError('Access revoked', 'REVOKED');
            if (r.status === 402)
                throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED');
            throw new Error(r.error);
        }
        return r.data;
    }
}
exports.TimSyncClient = TimSyncClient;
//# sourceMappingURL=client.js.map