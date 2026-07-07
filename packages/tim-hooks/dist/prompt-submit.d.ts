import type { TimStore } from 'tim-store';
export interface PromptSubmitParams {
    prompt: string;
    projectLabel?: string;
    timeoutMs?: number;
}
export interface PromptSubmitResult {
    lines: string[];
    context: string;
}
/**
 * UserPromptSubmit hook: hybrid FTS retrieval + optional guard warnings.
 * Never throws; returns null when disabled, empty, slow, or on error.
 */
export declare function runPromptSubmit(store: TimStore, params: PromptSubmitParams): Promise<PromptSubmitResult | null>;
//# sourceMappingURL=prompt-submit.d.ts.map