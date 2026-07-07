/**
 * Pure gate decision for tim_load_project: one bind per session unless same-project refresh.
 * P0000 Inbox counts as unbound — first real project load always allowed.
 */
export declare function evaluateLoadGate(existingProjectRef: string | undefined | null, requestedLabel: string): 'bind' | 'reject';
//# sourceMappingURL=load-gate.d.ts.map