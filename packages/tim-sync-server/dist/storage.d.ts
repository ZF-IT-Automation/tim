import type { TenantRegistry } from './tenant-registry.js';
import type { TenantTier } from './quotas.js';
export interface PushBlobInput {
    proposed_id: string;
    data: string;
    device_id: string;
    updated_at: string;
}
export declare function createFile(registry: TenantRegistry, tenantId: string, fileId: string, salt: string): {
    id: string;
    salt: string;
} | {
    conflict: true;
};
export declare function listFiles(registry: TenantRegistry, tenantId: string): {
    id: string;
    salt: string;
}[];
export declare function pushBlobs(registry: TenantRegistry, tenantId: string, tier: TenantTier, fileId: string, idempotencyKey: string, blobs: PushBlobInput[]): {
    mappings: {
        proposed_id: string;
        final_id: number;
    }[];
} | {
    error: string;
    status: number;
};
export declare function pullBlobs(registry: TenantRegistry, tenantId: string, fileId: string, cursor?: string): {
    blobs: unknown[];
    salt?: string;
    next_cursor: string;
    has_more: boolean;
} | {
    error: string;
    status: number;
};
//# sourceMappingURL=storage.d.ts.map