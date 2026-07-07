"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readGitCommit = readGitCommit;
exports.isGitRepo = isGitRepo;
const child_process_1 = require("child_process");
function git(cwd, args) {
    return (0, child_process_1.execFileSync)('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
/** Read commit metadata from git. Defaults to HEAD when hash omitted. */
function readGitCommit(cwd, hash) {
    const h = hash ?? git(cwd, ['rev-parse', 'HEAD']);
    const message = git(cwd, ['log', '-1', '--format=%B', h]);
    const author = git(cwd, ['log', '-1', '--format=%an', h]);
    const date = git(cwd, ['log', '-1', '--format=%aI', h]);
    let branch = 'HEAD';
    try {
        branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    }
    catch {
        /* detached HEAD */
    }
    let diffSummary = '';
    try {
        diffSummary = git(cwd, ['show', '--stat', '--format=', h]);
    }
    catch {
        /* root commit or empty tree */
    }
    return { hash: h, message, author, date, branch, diffSummary };
}
function isGitRepo(cwd) {
    try {
        git(cwd, ['rev-parse', '--git-dir']);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=git-commit.js.map