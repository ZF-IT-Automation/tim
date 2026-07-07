import type { TimStore } from 'tim-store';
export interface DeltaBriefingOptions {
    timeoutMs?: number;
    sessionId?: string;
}
export declare function getDeltaBriefing(store: TimStore, projectId: string, opts?: DeltaBriefingOptions): Promise<string | null>;
//# sourceMappingURL=delta.d.ts.map