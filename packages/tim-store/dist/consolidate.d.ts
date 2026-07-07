import Database from 'better-sqlite3';
import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
export type ConsolidationType = 'duplicate' | 'decay';
export type CurationStatus = 'pending' | 'done' | 'rejected';
export interface ConsolidationCandidate {
    id: string;
    consolidation: ConsolidationType;
    pair?: [string, string];
    target?: string;
    score?: number;
    reason: string;
}
export interface CurationMetadata {
    kind: 'curation';
    consolidation: ConsolidationType;
    status: CurationStatus;
    pair?: [string, string];
    target?: string;
    score?: number;
    reason: string;
    project_ref: string;
    dedup_key: string;
}
export declare class ConsolidationManager {
    private db;
    private store;
    constructor(db: Database.Database, store: TimStore);
    private resolveProject;
    private getProjectContentEntries;
    private loadVectors;
    private findExistingCuration;
    enqueue(projectLabel: string, type: ConsolidationType, metadata: Omit<CurationMetadata, 'kind' | 'project_ref' | 'dedup_key'>): Promise<Entry | null>;
    getCurationQueue(projectLabel: string, status?: CurationStatus): Promise<Entry[]>;
    getCurationStats(projectLabel: string): Promise<Record<string, number>>;
    setCurationDone(entryId: string): Promise<Entry>;
    setCurationRejected(entryId: string): Promise<Entry>;
    findDuplicateCandidates(projectLabel: string, opts?: {
        threshold?: number;
    }): Promise<ConsolidationCandidate[]>;
    private hasFreshEdges;
    findDecayCandidates(projectLabel: string, opts?: {
        accessDays?: number;
        accessCount?: number;
        verifiedDays?: number;
    }): Promise<ConsolidationCandidate[]>;
}
//# sourceMappingURL=consolidate.d.ts.map