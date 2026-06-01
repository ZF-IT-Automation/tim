import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import { findChildByKind } from './session-tree.js';
import {
  COMMITS_SECTION_ORDER,
  COMMITS_SECTION_TITLE,
  COMMIT_TAG,
  KIND_COMMIT,
  KIND_COMMITS_ROOT,
} from './commit-tree.js';

export interface RecordCommitParams {
  projectId: string;
  hash: string;
  message: string;
  diffSummary?: string;
  sessionId?: string;
  branch?: string;
  author?: string;
  date?: string;
}

export class CommitManager {
  constructor(private store: TimStore) {}

  async ensureCommitsSection(projectId: string): Promise<Entry> {
    const project = await this.store.read(projectId);
    if (!project || project.metadata.kind !== 'project') {
      throw new Error(`Project not found: ${projectId}`);
    }

    const existing = await findChildByKind(this.store, project.id, KIND_COMMITS_ROOT);
    if (existing) return existing;

    return this.store.write(COMMITS_SECTION_TITLE, {
      parentId: project.id,
      metadata: { kind: KIND_COMMITS_ROOT, render_depth: 1, order: COMMITS_SECTION_ORDER },
      tags: ['#commits'],
    });
  }

  async findCommitByHash(commitsSectionId: string, hash: string): Promise<Entry | null> {
    const commits = await this.store.getChildByKind(commitsSectionId, KIND_COMMIT);
    return commits.find(c => c.metadata.commit_hash === hash) ?? null;
  }

  async recordCommit(params: RecordCommitParams): Promise<Entry> {
    const section = await this.ensureCommitsSection(params.projectId);
    const existing = await this.findCommitByHash(section.id, params.hash);
    if (existing) return existing;

    const bodyParts = [params.message.trim()];
    if (params.diffSummary?.trim()) {
      bodyParts.push('', params.diffSummary.trim());
    }

    const commit = await this.store.write(bodyParts.join('\n'), {
      parentId: section.id,
      title: params.hash,
      metadata: {
        kind: KIND_COMMIT,
        commit_hash: params.hash,
        ...(params.branch && { branch: params.branch }),
        ...(params.author && { author: params.author }),
        ...(params.date && { date: params.date }),
      },
      tags: [COMMIT_TAG],
    });

    if (params.sessionId) {
      const session = await this.store.read(params.sessionId);
      if (session?.metadata.kind === 'session') {
        await this.store.link(commit.id, params.sessionId, 'relates');
        await this.store.link(params.sessionId, commit.id, 'implements');
      }
    }

    return commit;
  }
}
