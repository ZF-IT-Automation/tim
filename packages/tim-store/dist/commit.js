"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommitManager = void 0;
const session_tree_js_1 = require("./session-tree.js");
const commit_tree_js_1 = require("./commit-tree.js");
class CommitManager {
    store;
    constructor(store) {
        this.store = store;
    }
    async ensureCommitsSection(projectId) {
        const project = await this.store.requireProject(projectId);
        const existing = await (0, session_tree_js_1.findChildByKind)(this.store, project.id, commit_tree_js_1.KIND_COMMITS_ROOT);
        if (existing)
            return existing;
        return this.store.write(commit_tree_js_1.COMMITS_SECTION_TITLE, {
            parentId: project.id,
            metadata: { kind: commit_tree_js_1.KIND_COMMITS_ROOT, render_depth: 1, order: commit_tree_js_1.COMMITS_SECTION_ORDER },
            tags: ['#commits'],
        });
    }
    async findCommitByHash(commitsSectionId, hash) {
        const commits = await this.store.getChildByKind(commitsSectionId, commit_tree_js_1.KIND_COMMIT);
        return commits.find(c => c.metadata.commit_hash === hash) ?? null;
    }
    async recordCommit(params) {
        const section = await this.ensureCommitsSection(params.projectId);
        const existing = await this.findCommitByHash(section.id, params.hash);
        if (existing)
            return existing;
        const bodyParts = [params.message.trim()];
        if (params.diffSummary?.trim()) {
            bodyParts.push('', params.diffSummary.trim());
        }
        const commit = await this.store.write(bodyParts.join('\n'), {
            parentId: section.id,
            title: params.hash,
            metadata: {
                kind: commit_tree_js_1.KIND_COMMIT,
                commit_hash: params.hash,
                ...(params.branch && { branch: params.branch }),
                ...(params.author && { author: params.author }),
                ...(params.date && { date: params.date }),
            },
            tags: [commit_tree_js_1.COMMIT_TAG],
        });
        if (params.sessionId) {
            const session = await this.store.readSession(params.sessionId);
            if (session) {
                await this.store.link(commit.id, session.id, 'relates');
                await this.store.link(session.id, commit.id, 'implements');
            }
        }
        return commit;
    }
}
exports.CommitManager = CommitManager;
//# sourceMappingURL=commit.js.map