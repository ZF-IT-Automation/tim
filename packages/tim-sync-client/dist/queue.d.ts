import type { PushBlob } from './client.js';
import type { TimEnvelope } from './envelope.js';
export interface QueueItem {
    idempotency_key: string;
    envelopes: TimEnvelope[];
    blobs: PushBlob[];
    created_at: string;
    attempts: number;
}
export declare const PUSH_CHUNK = 500;
export declare function loadQueue(path: string): QueueItem[];
export declare function saveQueue(path: string, items: QueueItem[]): void;
export declare function enqueue(path: string, q: QueueItem[], envelopes: TimEnvelope[], blobs: PushBlob[]): QueueItem[];
export declare function flushQueue(path: string, q: QueueItem[], send: (item: QueueItem) => Promise<void>): Promise<{
    ok: boolean;
    sent: QueueItem[];
}>;
//# sourceMappingURL=queue.d.ts.map