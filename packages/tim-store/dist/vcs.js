"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectProjectVcs = detectProjectVcs;
const node_child_process_1 = require("node:child_process");
function detectProjectVcs(projectPath) {
    try {
        const stdout = (0, node_child_process_1.execFileSync)('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: projectPath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (stdout.includes('true')) {
            return 'git';
        }
        return 'none';
    }
    catch {
        return 'none';
    }
}
//# sourceMappingURL=vcs.js.map