import type { TimStore } from './store.js';
export declare const CHARS_PER_TOKEN = 4;
export interface ProjectTokenEstimate {
    label: string;
    title: string;
    estChars: number;
    estTokens: number;
    overBriefingBudget: boolean;
}
export declare function charsToTokens(chars: number): number;
/**
 * Estimate briefing size for a project subtree (title + content chars).
 */
export declare function estimateProjectTokens(store: TimStore, projectLabel: string, maxTokens: number): Promise<ProjectTokenEstimate | null>;
export declare function listProjectTokenEstimates(store: TimStore, maxTokens: number): Promise<ProjectTokenEstimate[]>;
//# sourceMappingURL=token-budget.d.ts.map