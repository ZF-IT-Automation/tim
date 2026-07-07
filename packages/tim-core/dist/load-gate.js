"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateLoadGate = evaluateLoadGate;
/**
 * Pure gate decision for tim_load_project: one bind per session unless same-project refresh.
 * P0000 Inbox counts as unbound — first real project load always allowed.
 */
function evaluateLoadGate(existingProjectRef, requestedLabel) {
    if (!existingProjectRef || existingProjectRef === 'P0000') {
        return 'bind';
    }
    if (existingProjectRef === requestedLabel) {
        return 'bind';
    }
    return 'reject';
}
//# sourceMappingURL=load-gate.js.map