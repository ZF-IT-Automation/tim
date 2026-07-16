"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCallerProjectPath = resolveCallerProjectPath;
const tim_hooks_1 = require("tim-hooks");
/**
 * Resolve the filesystem project path for auto-detecting coding-task `vcs`.
 * Stdio MCP: prefer the bound `.tim-project` directory (walk-up), else cwd.
 * HTTP MCP: never guess — server cwd is not the caller's project.
 */
function resolveCallerProjectPath(isHttp, cwd = process.cwd(), markerOptions) {
    if (isHttp)
        return undefined;
    return (0, tim_hooks_1.findMarker)(cwd, { walkUp: true, ...markerOptions })?.dir ?? cwd;
}
//# sourceMappingURL=project-path.js.map