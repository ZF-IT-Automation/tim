import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export interface RecordCommitParams {
    projectId: string;
    hash: string;
    message: string;
    diffSummary?: string;
    sessionId?: string;
    branch?: string;
    author?: string;
    date?: string;
}
export declare class CommitManager {
    private store;
    constructor(store: TimStore);
    ensureCommitsSection(projectId: string): Promise<Entry>;
    findCommitByHash(commitsSectionId: string, hash: string): Promise<Entry | null>;
    recordCommit(params: RecordCommitParams): Promise<Entry>;
}
//# sourceMappingURL=commit.d.ts.map