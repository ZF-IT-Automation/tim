"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requiresSnapshot = requiresSnapshot;
exports.requiresConfirm = requiresConfirm;
function requiresSnapshot(command, flags) {
    if (flags.dryRun === true || flags['dry-run'] === 'true')
        return false;
    return ['import', 'repair-flags', 'migrate-from-hmem'].includes(command);
}
function requiresConfirm(command, flags) {
    const force = flags.force === true || flags.force === 'true';
    const hard = flags.hard === true || flags.hard === 'true';
    if (command === 'restore' && force)
        return true;
    if (command === 'delete-batch' && hard)
        return true;
    return false;
}
//# sourceMappingURL=safety.js.map