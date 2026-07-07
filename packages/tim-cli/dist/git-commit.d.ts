export interface GitCommitInfo {
    hash: string;
    message: string;
    author: string;
    date: string;
    branch: string;
    diffSummary: string;
}
/** Read commit metadata from git. Defaults to HEAD when hash omitted. */
export declare function readGitCommit(cwd: string, hash?: string): GitCommitInfo;
export declare function isGitRepo(cwd: string): boolean;
//# sourceMappingURL=git-commit.d.ts.map