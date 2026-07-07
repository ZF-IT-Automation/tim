export declare class SyncApiError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
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
    mappings: {
        proposed_id: string;
        final_id: number;
    }[];
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
export declare class TimSyncClient {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    private request;
    health(): Promise<boolean>;
    healthDetails(): Promise<Record<string, unknown> | null>;
    register(tier?: 'free' | 'pro'): Promise<{
        token: string;
        tenant_id: string;
        tier: string;
    }>;
    syncStatus(): Promise<{
        tier: string;
        entry_count: number;
        total_bytes: number;
    }>;
    listFiles(): Promise<TimFile[]>;
    createFile(id: string, salt: string): Promise<TimFile>;
    push(req: PushRequest): Promise<PushResponse>;
    pull(fileId: string, cursor?: string, clientSchemaMajor?: number): Promise<PullResponse>;
}
//# sourceMappingURL=client.d.ts.map