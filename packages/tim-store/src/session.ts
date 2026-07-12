import type { Entry } from 'tim-core';
import { loadConfig } from 'tim-core';
import type { TimStore } from './store.js';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_BATCH_SIZE,
  deriveCounters,
  deriveCountersSync,
  EXCHANGES_NODE_TITLE,
  findChildByKind,
  KIND_BATCH,
  KIND_EXCHANGE,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_SESSION,
  KIND_SESSIONS_ROOT,
  KIND_SUMMARY_ROOT,
  SESSION_SUMMARY_TAG,
  BATCH_SUMMARY_TAG,
  BATCH_STRUCTURAL_TAGS,
  SESSIONS_SECTION_ORDER,
  SESSIONS_SECTION_TITLE,
  SUMMARY_NODE_TITLE,
} from './session-tree.js';

export type ExchangeRole = 'user' | 'agent';

export interface Exchange {
  role: ExchangeRole;
  content: string;
}

export type Summarizer = (exchanges: Entry[]) => Promise<string>;

export interface BatchFullInfo {
  sessionId: string;
  batchId: string;
  batchIndex: number;
}

export type OnBatchFullHandler = (info: BatchFullInfo) => void;

export interface SessionStartParams {
  sessionId: string;
  agentName: string;
  cwd: string;
  harness: string;
}

export interface ProjectSessionParams extends SessionStartParams {
  projectId: string;
  batchSize?: number;
  summarizer?: { cli: string; model: string };
  tool?: string;
  model?: string;
  taskSummary?: string;
}

export interface UnsummarizedExchange {
  seq: number;
  userId: string;
  userContent: string;
  agentId: string | null;
  agentContent: string | null;
}

export interface UnsummarizedBatch {
  sessionId: string;
  summaryNodeId: string;
  exchangesNodeId: string;
  batchIndex: number;
  batchSize: number;
  exchanges: UnsummarizedExchange[];
  hasMore: boolean;
  previousSummaries: string[];
  sessionMeta: {
    project?: string;
    tool?: string;
    model?: string;
    task_summary?: string;
  };
}

export interface ResumeBatchSummary {
  batchIndex: number;
  seqFrom: number;
  seqTo: number;
  text: string;
}
export interface ResumeExchange {
  seq: number;
  userContent: string;
  agentContent: string | null;
}
export interface ResumePayload {
  sessionId: string;
  sessionMeta: {
    project?: string;
    date?: string;
    tool?: string;
    toolHistory: string[];
    exchangeCount: number;
    taskSummary?: string;
  };
  sessionSummary: string;
  batchSummaries: ResumeBatchSummary[];
  recentExchanges: ResumeExchange[];
  warnings: string[];
}
export interface ResumeSessionOpts {
  newHarnessId?: string;
  tool?: string;
  model?: string;
  rawCount?: number;
}

export interface ResumableSession {
  sessionId: string;
  title: string;
  date?: string;
  lastActivity: string;
  tool?: string;
  taskSummary?: string;
  exchangeCount: number;
  summaryFirstLine: string;
}

export interface UntaggedBatch {
  sessionId: string;
  batchNodeId: string;
  batchIndex: number;
  title: string;
  seqFrom: number;
  seqTo: number;
}

const DEFAULT_SUMMARIZER: Summarizer = async (exchanges) => {
  if (exchanges.length === 0) return 'Empty session — no exchanges to checkpoint.';

  const userMsgs = exchanges.filter(e => e.metadata.role === 'user');
  const agentMsgs = exchanges.filter(e => e.metadata.role === 'agent');

  const topics = userMsgs
    .slice(0, 5)
    .map(e => {
      const text = (e.content || e.title || '').trim();
      // Extract first sentence or first 120 chars as topic indicator
      const firstSentence = text.split(/[.!?\n]/)[0]?.trim() ?? text;
      return firstSentence.length > 120 ? firstSentence.slice(0, 117) + '…' : firstSentence;
    })
    .filter(Boolean);

  const decisionHints = agentMsgs
    .slice(0, 3)
    .map(e => {
      const text = (e.content || e.title || '').trim();
      return text.length > 100 ? text.slice(0, 97) + '…' : text;
    })
    .filter(Boolean);

  let summary = `Session checkpoint: ${exchanges.length} exchanges`;
  if (topics.length) {
    summary += `\nTopics: ${topics.map((t, i) => `${i + 1}. ${t}`).join('; ')}`;
  }
  if (decisionHints.length) {
    summary += `\nAgent responses hint at: ${decisionHints.join(' | ')}`;
  }

  return summary.length > 2000 ? summary.slice(0, 1997) + '…' : summary;
};

export class SessionManager {
  private onBatchFull?: OnBatchFullHandler;

  constructor(private store: TimStore) {}

  /** Live summarizer trigger when an exchange-batch fills (wired from tim-mcp). */
  setOnBatchFull(handler: OnBatchFullHandler | undefined): void {
    this.onBatchFull = handler;
  }

  async sessionStart(params: SessionStartParams): Promise<Entry> {
    const { sessionId, agentName, cwd, harness } = params;
    const existing = await this.store.read(sessionId);
    if (existing?.metadata.kind === 'session') {
      return existing;
    }

    return this.store.write(`Session ${sessionId}`, {
      id: sessionId,
      metadata: {
        kind: 'session',
        sessionId,
        agent: agentName,
        harness,
        cwd,
      },
      tags: ['#session'],
    });
  }

  async startProjectSession(params: ProjectSessionParams): Promise<Entry> {
    const { sessionId, projectId, agentName, cwd, harness, tool, model, taskSummary } = params;

    const existing = await this.store.read(sessionId);
    if (existing?.metadata.kind === KIND_SESSION) {
      if (existing.metadata.project_ref !== projectId) {
        const newProject = await this.store.requireProject(projectId);

        let newSessionsSection = await findChildByKind(
          this.store,
          newProject.id,
          KIND_SESSIONS_ROOT,
        );
        if (!newSessionsSection) {
          newSessionsSection = await this.store.write(SESSIONS_SECTION_TITLE, {
            parentId: newProject.id,
            metadata: { kind: KIND_SESSIONS_ROOT, render_depth: 0, order: SESSIONS_SECTION_ORDER },
            tags: ['#sessions'],
          });
        }

        await this.store.update(sessionId, {
          metadata: { ...existing.metadata, project_ref: projectId },
        });
        this.store.curate().moveEntry(sessionId, newSessionsSection.id);
      }
      return (await this.store.read(sessionId))!;
    }

    const project = await this.store.requireProject(projectId);

    let sessionsSection = await findChildByKind(this.store, project.id, KIND_SESSIONS_ROOT);
    if (!sessionsSection) {
      sessionsSection = await this.store.write(SESSIONS_SECTION_TITLE, {
        parentId: project.id,
        metadata: { kind: KIND_SESSIONS_ROOT, render_depth: 0, order: SESSIONS_SECTION_ORDER },
        tags: ['#sessions'],
      });
    }

    const date = new Date().toISOString();
    const title = date.slice(0, 16).replace('T', '-').replace(':', '');
    const session = await this.store.write(title, {
      id: sessionId,
      parentId: sessionsSection.id,
      metadata: {
        kind: KIND_SESSION,
        sessionId,
        project_ref: projectId,
        agent: agentName,
        harness,
        cwd,
        date,
        batch_size: params.batchSize ?? DEFAULT_BATCH_SIZE,
        summarizer: params.summarizer ?? { cli: 'tim-summarizer', model: 'default' },
        exchange_count: 0,
        batches_summarized: 0,
        device: os.hostname(),
        ...(tool && { tool }),
        ...(model && { model }),
        ...(taskSummary && { task_summary: taskSummary }),
      },
      tags: ['#session'],
    });

    await this.store.write(SUMMARY_NODE_TITLE, {
      parentId: session.id,
      metadata: { kind: KIND_SUMMARY_ROOT, exchanges: 0, date, summary: '' },
      tags: [SESSION_SUMMARY_TAG],
    });
    const exchangesNode = await this.store.write(EXCHANGES_NODE_TITLE, {
      parentId: session.id,
      metadata: { kind: KIND_EXCHANGES_ROOT, render_depth: 0 },
      tags: ['#exchanges'],
    });
    await this.store.write('Batch 1', {
      parentId: exchangesNode.id,
      metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: 1, order: 1 },
    });

    return session;
  }

  async sessionLog(sessionId: string, entries: Exchange[]): Promise<Entry[]> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const session = await this.store.read(sessionId);
    if (!session || session.metadata.kind !== 'session') {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const exchanges = await this.getSessionExchanges(sessionId);
    let nextSeq = exchanges.reduce((max, e) => {
      const seq = typeof e.metadata.seq === 'number' ? e.metadata.seq : 0;
      return Math.max(max, seq);
    }, 0);

    const written: Entry[] = [];
    for (const exchange of entries) {
      nextSeq += 1;
      const entry = await this.store.write(exchange.content, {
        parentId: sessionId,
        metadata: {
          kind: 'exchange',
          role: exchange.role,
          seq: nextSeq,
          sessionId,
        },
        tags: ['#exchange'],
      });
      written.push(entry);
    }
    return written;
  }

  async logExchange(sessionId: string, entries: Exchange[]): Promise<Entry[]> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const session = await this.store.read(sessionId);
    if (!session || session.metadata.kind !== KIND_SESSION) {
      throw new Error(`Project session not found: ${sessionId}`);
    }
    const exNode = await findChildByKind(this.store, sessionId, KIND_EXCHANGES_ROOT);
    if (!exNode) throw new Error(`Exchanges node missing for session: ${sessionId}`);

    const batchSize =
      typeof session.metadata.batch_size === 'number'
        ? session.metadata.batch_size
        : DEFAULT_BATCH_SIZE;

    const written = this.store.runExclusive(() => {
      let allBatches = this.store.getChildByKindSync(exNode.id, KIND_EXCHANGE_BATCH);
      let batchNode = allBatches[allBatches.length - 1] ?? null;
      if (!batchNode) {
        batchNode = this.store.writeSync('Batch 1', {
          parentId: exNode.id,
          metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: 1, order: 1 },
        });
        allBatches = [batchNode];
      }

      let usersInBatch = this.store.getChildrenBySeqSync(batchNode.id).filter(
        u => u.metadata.role === 'user',
      );

      const allUserNodes: Entry[] = [];
      for (const b of allBatches) {
        const users = this.store.getChildrenBySeqSync(b.id).filter(
          u => u.metadata.role === 'user',
        );
        allUserNodes.push(...users);
      }
      let seq = allUserNodes.reduce(
        (m, u) => Math.max(m, typeof u.metadata.seq === 'number' ? u.metadata.seq : 0),
        0,
      );

      let currentUser: Entry | null = allUserNodes[allUserNodes.length - 1] ?? null;
      const result: Entry[] = [];

      for (const e of entries) {
        if (e.role === 'user') {
          if (usersInBatch.length >= batchSize) {
            const fullBatchId = batchNode.id;
            const fullBatchIndex =
              typeof batchNode.metadata.batch_index === 'number'
                ? batchNode.metadata.batch_index
                : allBatches.length;
            const nextIndex = fullBatchIndex + 1;
            batchNode = this.store.writeSync(`Batch ${nextIndex}`, {
              parentId: exNode.id,
              metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: nextIndex, order: nextIndex },
            });
            allBatches.push(batchNode);
            usersInBatch = [];
            this.onBatchFull?.({
              sessionId,
              batchId: fullBatchId,
              batchIndex: fullBatchIndex,
            });
          }
          seq += 1;
          currentUser = this.store.writeSync(e.content, {
            parentId: batchNode.id,
            metadata: { kind: KIND_EXCHANGE, role: 'user', seq, sessionId },
            tags: ['#exchange'],
          });
          usersInBatch.push(currentUser);
          result.push(currentUser);
        } else {
          const parentId = currentUser ? currentUser.id : batchNode.id;
          const agentSeq = currentUser ? currentUser.metadata.seq : seq;
          const a = this.store.writeSync(e.content, {
            parentId,
            metadata: { kind: KIND_EXCHANGE, role: 'agent', seq: agentSeq, sessionId },
            tags: ['#exchange'],
          });
          result.push(a);
        }
      }

      const { exchangeCount } = deriveCountersSync(this.store, sessionId);
      const freshSession = this.store.readSync(sessionId);
      if (freshSession) {
        this.store.updateSync(sessionId, {
          metadata: { ...freshSession.metadata, exchange_count: exchangeCount },
        });
      }

      return result;
    });

    return written;
  }

  async showUnsummarized(sessionId: string): Promise<UnsummarizedBatch> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const session = await this.store.read(sessionId);
    if (!session || session.metadata.kind !== KIND_SESSION) {
      throw new Error(`Project session not found: ${sessionId}`);
    }
    const exNode = await findChildByKind(this.store, sessionId, KIND_EXCHANGES_ROOT);
    const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
    if (!exNode || !summaryNode) throw new Error(`Session subtree incomplete: ${sessionId}`);

    const batchSize = typeof session.metadata.batch_size === 'number'
      ? session.metadata.batch_size
      : DEFAULT_BATCH_SIZE;

    const { batchesSummarized } = await deriveCounters(this.store, sessionId);

    const exchangeBatches = (await this.store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH))
      .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index));
    const summaryBatches = await this.store.getChildByKind(summaryNode.id, KIND_BATCH);
    const summaryByIndex = new Map(
      summaryBatches.map(s => [Number(s.metadata.batch_index), s]),
    );

    const batchHasUncovered = async (batchNode: Entry): Promise<boolean> => {
      const batchIdx = Number(batchNode.metadata.batch_index);
      const summary = summaryByIndex.get(batchIdx);
      const users = (await this.store.getChildrenBySeq(batchNode.id)).filter(
        u => u.metadata.role === 'user',
      );
      if (users.length === 0) return false;
      if (!summary) return true;
      const maxSeq = Math.max(...users.map(u => Number(u.metadata.seq)));
      return maxSeq > Number(summary.metadata.seq_to);
    };

    let targetBatchIndex: number | null = null;
    let seqFloor = 0;
    for (const batchNode of exchangeBatches) {
      const batchIdx = Number(batchNode.metadata.batch_index);
      const summary = summaryByIndex.get(batchIdx);
      const users = (await this.store.getChildrenBySeq(batchNode.id)).filter(
        u => u.metadata.role === 'user',
      );
      if (users.length === 0) continue;
      if (!summary) {
        targetBatchIndex = batchIdx;
        seqFloor = 0;
        break;
      }
      const maxSeq = Math.max(...users.map(u => Number(u.metadata.seq)));
      const seqTo = Number(summary.metadata.seq_to);
      if (maxSeq > seqTo) {
        targetBatchIndex = batchIdx;
        seqFloor = seqTo;
        break;
      }
    }

    const batchIndex = targetBatchIndex ?? batchesSummarized + 1;
    const batchNode =
      (targetBatchIndex != null
        ? exchangeBatches.find(b => b.metadata.batch_index === targetBatchIndex)
        : exchangeBatches.find(b => b.metadata.batch_index === batchIndex)) ?? null;

    const exchanges: UnsummarizedExchange[] = [];
    if (batchNode && targetBatchIndex != null) {
      const users = (await this.store.getChildrenBySeq(batchNode.id)).filter(
        u => u.metadata.role === 'user',
      );
      for (const u of users) {
        const seq = Number(u.metadata.seq);
        if (seq <= seqFloor) continue;
        const replies = await this.store.getChildren(u.id);
        const agent = replies.find(r => r.metadata.role === 'agent') ?? null;
        exchanges.push({
          seq,
          userId: u.id,
          userContent: u.content || u.title,
          agentId: agent?.id ?? null,
          agentContent: agent ? (agent.content || agent.title) : null,
        });
      }
    }

    const hasMore = await (async () => {
      for (const b of exchangeBatches) {
        if (Number(b.metadata.batch_index) <= batchIndex) continue;
        if (await batchHasUncovered(b)) return true;
      }
      return false;
    })();

    const previousSummaries: string[] = [];
    if (summaryNode) {
      const summaries = await this.store.getChildren(summaryNode.id);
      for (const s of summaries) {
        if (s.tags?.includes(SESSION_SUMMARY_TAG)) {
          previousSummaries.push(s.title || s.content || '');
        }
      }
    }

    const sessionMeta = {
      project: typeof session.metadata.project_ref === 'string' ? session.metadata.project_ref : undefined,
      tool: typeof session.metadata.tool === 'string' ? session.metadata.tool : undefined,
      model: typeof session.metadata.model === 'string' ? session.metadata.model : undefined,
      task_summary: typeof session.metadata.task_summary === 'string' ? session.metadata.task_summary : undefined,
    };

    return {
      sessionId,
      summaryNodeId: summaryNode.id,
      exchangesNodeId: exNode.id,
      batchIndex,
      batchSize,
      exchanges,
      hasMore,
      previousSummaries,
      sessionMeta,
    };
  }

  async writeBatchSummary(
    sessionId: string,
    batchIndex: number,
    summaryText: string,
    range: { seqFrom: number; seqTo: number },
    tags?: string[],
  ): Promise<Entry> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
    if (!summaryNode) throw new Error(`Summary node missing for session: ${sessionId}`);

    const entry = this.store.runExclusive(() =>
      this.writeBatchSummarySync(sessionId, summaryNode, batchIndex, summaryText, range, tags),
    );
    await this.aggregateSessionTags(sessionId);
    return entry;
  }

  private writeBatchSummarySync(
    sessionId: string,
    summaryNode: Entry,
    batchIndex: number,
    summaryText: string,
    range: { seqFrom: number; seqTo: number },
    tags?: string[],
  ): Entry {
    const findExisting = () =>
      this.store.getChildByKindSync(summaryNode.id, KIND_BATCH)
        .find(b => b.metadata.batch_index === batchIndex);

    const upsertExisting = (existing: Entry): Entry => {
      const existingSeqFrom = Number(existing.metadata.seq_from);
      const existingSeqTo = Number(existing.metadata.seq_to);
      const rangeCovered =
        range.seqFrom >= existingSeqFrom && range.seqTo <= existingSeqTo;
      if (rangeCovered) return existing;

      const mergedFrom = Math.min(existingSeqFrom, range.seqFrom);
      const mergedTo = Math.max(existingSeqTo, range.seqTo);
      const summarizedAt = new Date().toISOString();
      const contentTags = tags ?? [];
      const mergedTags = [
        SESSION_SUMMARY_TAG,
        BATCH_SUMMARY_TAG,
        ...new Set([
          ...(existing.tags ?? []).filter(t => !BATCH_STRUCTURAL_TAGS.has(t)),
          ...contentTags,
        ]),
      ];
      this.store.updateSync(existing.id, {
        content: summaryText,
        metadata: {
          ...existing.metadata,
          kind: KIND_BATCH,
          batch_index: batchIndex,
          seq_from: mergedFrom,
          seq_to: mergedTo,
          sessionId,
          summarized_at: summarizedAt,
        },
        tags: mergedTags,
      });
      return this.store.readSync(existing.id)!;
    };

    const existing = findExisting();
    if (existing) {
      const updated = upsertExisting(existing);
      this.syncSessionBatchesSummarized(sessionId, summaryNode.id);
      return updated;
    }

    const summarizedAt = new Date().toISOString();
    const contentTags = tags ?? [];
    try {
      const node = this.store.writeSync(summaryText, {
        parentId: summaryNode.id,
        title: `Batch ${batchIndex}`,
        metadata: {
          kind: KIND_BATCH,
          batch_index: batchIndex,
          seq_from: range.seqFrom,
          seq_to: range.seqTo,
          sessionId,
          summarized_at: summarizedAt,
        },
        tags: [SESSION_SUMMARY_TAG, BATCH_SUMMARY_TAG, ...contentTags],
      });
      this.syncSessionBatchesSummarized(sessionId, summaryNode.id);
      return node;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT') {
        const raced = findExisting();
        if (!raced) throw err;
        const updated = upsertExisting(raced);
        this.syncSessionBatchesSummarized(sessionId, summaryNode.id);
        return updated;
      }
      throw err;
    }
  }

  private syncSessionBatchesSummarized(sessionId: string, summaryNodeId: string): void {
    const session = this.store.readSync(sessionId);
    if (!session) return;
    const batchesSummarized = this.store.getChildByKindSync(summaryNodeId, KIND_BATCH).length;
    this.store.updateSync(sessionId, {
      metadata: { ...session.metadata, batches_summarized: batchesSummarized },
    });
  }

  /** Recompute session-level content tags from batch summaries (freq >= 2). */
  async aggregateSessionTags(sessionId: string): Promise<Entry | null> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
    if (!summaryNode) return null;

    const batches = await this.store.getChildByKind(summaryNode.id, KIND_BATCH);
    const freq = new Map<string, number>();
    for (const batch of batches) {
      const contentTags = (batch.tags ?? []).filter(t => !BATCH_STRUCTURAL_TAGS.has(t));
      for (const tag of new Set(contentTags)) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1);
      }
    }

    const aggregated = [...freq.entries()]
      .filter(([, count]) => count >= 2)
      .map(([tag]) => tag)
      .sort();

    await this.store.update(summaryNode.id, {
      tags: [SESSION_SUMMARY_TAG, ...aggregated],
    });
    return (await this.store.read(summaryNode.id))!;
  }

  /** Batch summary nodes with no content tags (only structural tags). */
  async showUntagged(): Promise<UntaggedBatch[]> {
    const results: UntaggedBatch[] = [];
    const sessions = await this.store.getByMetadataKind(KIND_SESSION, 100);
    for (const session of sessions) {
      try {
        const summaryNode = await findChildByKind(this.store, session.id, KIND_SUMMARY_ROOT);
        if (!summaryNode) continue;

        const batches = await this.store.getChildByKind(summaryNode.id, KIND_BATCH);
        for (const batch of batches) {
          const contentTags = (batch.tags ?? []).filter(t => !BATCH_STRUCTURAL_TAGS.has(t));
          if (contentTags.length > 0) continue;
          results.push({
            sessionId: session.id,
            batchNodeId: batch.id,
            batchIndex: Number(batch.metadata.batch_index),
            title: batch.title,
            seqFrom: Number(batch.metadata.seq_from),
            seqTo: Number(batch.metadata.seq_to),
          });
        }
      } catch {
        // Skip sessions with incomplete subtrees
      }
    }
    return results;
  }

  async rollUpSession(
    sessionId: string,
    fold: (batches: Entry[]) => Promise<string>,
  ): Promise<Entry> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
    if (!summaryNode) throw new Error(`Summary node missing for session: ${sessionId}`);

    const batches = await this.store.getChildByKind(summaryNode.id, KIND_BATCH);
    const text = await fold(batches);
    const { exchangeCount } = await deriveCounters(this.store, sessionId);
    const date = String(summaryNode.metadata.date ?? new Date().toISOString());

    await this.store.update(summaryNode.id, {
      title: SUMMARY_NODE_TITLE,
      content: text,
      metadata: { ...summaryNode.metadata, summary: text, exchanges: exchangeCount, date },
    });
    const updated = await this.store.read(summaryNode.id);
    return updated!;
  }

  async getSessionExchanges(sessionId: string): Promise<Entry[]> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const exNode = await findChildByKind(this.store, sessionId, KIND_EXCHANGES_ROOT);
    if (exNode) {
      const batches = await this.store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH);
      const out: Entry[] = [];
      for (const batch of batches) {
        const users = (await this.store.getChildrenBySeq(batch.id)).filter(
          u => u.metadata.role === 'user',
        );
        for (const u of users) {
          out.push(u);
          const replies = await this.store.getChildren(u.id);
          for (const r of replies) if (r.metadata.role === 'agent') out.push(r);
        }
      }
      return out;
    }
    return this.store.getChildren(sessionId, { metadataKind: KIND_EXCHANGE });
  }

  /** Scan all project sessions and return their unsummarized batches (cleanup sweep). */
  async showAllUnsummarized(): Promise<UnsummarizedBatch[]> {
    const results: UnsummarizedBatch[] = [];
    const sessions = await this.store.getByMetadataKind(KIND_SESSION, 100);
    for (const session of sessions) {
      try {
        const batch = await this.showUnsummarized(session.id);
        if (batch.exchanges.length > 0) results.push(batch);
      } catch {
        // Skip sessions with incomplete subtrees
      }
    }
    return results;
  }

  async checkpoint(
    sessionId: string,
    opts: { summarize?: Summarizer; runDecay?: boolean; handoffNote?: string } = {},
  ): Promise<Entry> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const session = await this.store.read(sessionId);
    if (!session || session.metadata.kind !== 'session') {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Find or create Summary node under session
    let summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
    if (!summaryNode) {
      const date = new Date().toISOString();
      summaryNode = await this.store.write(SUMMARY_NODE_TITLE, {
        parentId: sessionId,
        metadata: { kind: KIND_SUMMARY_ROOT, exchanges: 0, date, summary: '' },
        tags: [SESSION_SUMMARY_TAG],
      });
    }

    const exchanges = await this.getSessionExchanges(sessionId);
    const summarize = opts.summarize ?? DEFAULT_SUMMARIZER;
    const summaryText = await summarize(exchanges);

    const summary = await this.store.write(summaryText, {
      parentId: summaryNode.id,
      metadata: {
        kind: 'checkpoint',
        sessionId,
        count: exchanges.length,
        ...(opts.handoffNote ? { handoff_note: opts.handoffNote } : {}),
      },
      tags: [SESSION_SUMMARY_TAG, BATCH_SUMMARY_TAG, '#checkpoint'],
    });

    await this.store.link(summary.id, sessionId, 'summarizes');

    const verifiedSummary = await this.store.read(summary.id);
    const edges = await this.store.getEdges(summary.id, 'outgoing');
    const hasSummarizesEdge = edges.some(
      e => e.targetId === sessionId && e.type === 'summarizes',
    );

    if (!verifiedSummary || !hasSummarizesEdge) {
      throw new Error('Checkpoint verification failed: summary not durable');
    }

    if (opts.runDecay === true) {
      await this.store.runDecay({
        before: session.createdAt,
        exclude: [sessionId, summary.id],
      });
    }

    return summary;
  }

  /** Upsert session-summary-root content after checkpoint / rollup. */
  async updateSessionSummary(sessionId: string, summaryText: string): Promise<Entry> {
    sessionId = this.store.resolveSessionAlias(sessionId);
    const session = await this.store.read(sessionId);
    if (!session || session.metadata.kind !== KIND_SESSION) {
      throw new Error(`Project session not found: ${sessionId}`);
    }

    let summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
    const now = new Date().toISOString();

    if (summaryNode) {
      await this.store.update(summaryNode.id, {
        title: SUMMARY_NODE_TITLE,
        content: summaryText,
        metadata: {
          ...summaryNode.metadata,
          kind: KIND_SUMMARY_ROOT,
          summary: summaryText,
          date: now,
        },
      });
      return (await this.store.read(summaryNode.id))!;
    }

    summaryNode = await this.store.write(summaryText, {
      parentId: sessionId,
      title: SUMMARY_NODE_TITLE,
      metadata: {
        kind: KIND_SUMMARY_ROOT,
        sessionId,
        summary: summaryText,
        exchanges: 0,
        date: now,
      },
      tags: [SESSION_SUMMARY_TAG],
    });
    return summaryNode;
  }

  async resumeSession(
    oldSessionId: string,
    opts: ResumeSessionOpts = {},
  ): Promise<ResumePayload> {
    const canonical = this.store.resolveSessionAlias(oldSessionId);
    const session = await this.store.read(canonical);
    if (!session || session.metadata.kind !== KIND_SESSION) {
      throw new Error(`Session not found: ${oldSessionId}`);
    }
    const exNode = await findChildByKind(this.store, canonical, KIND_EXCHANGES_ROOT);
    if (!exNode) {
      throw new Error(`Session uses legacy format and cannot be resumed: ${oldSessionId}`);
    }
    const summaryNode = await findChildByKind(this.store, canonical, KIND_SUMMARY_ROOT);

    const warnings: string[] = [];
    const newHarnessId = opts.newHarnessId?.trim() || undefined;

    if (newHarnessId && newHarnessId !== canonical) {
      const existing = await this.store.read(newHarnessId);
      if (existing?.metadata.kind === KIND_SESSION) {
        const { exchangeCount } = await deriveCounters(this.store, newHarnessId);
        if (exchangeCount > 0) {
          throw new Error(
            `Harness session ${newHarnessId} already has ${exchangeCount} exchanges — ` +
            `start fresh or resume from that session instead`,
          );
        }
      }
      const fresh = (await this.store.read(canonical))!;
      const resumedBy = Array.isArray(fresh.metadata.resumed_by)
        ? [...(fresh.metadata.resumed_by as string[])]
        : [];
      if (!resumedBy.includes(newHarnessId)) resumedBy.push(newHarnessId);
      const toolHistory = Array.isArray(fresh.metadata.tool_history)
        ? [...(fresh.metadata.tool_history as string[])]
        : typeof fresh.metadata.tool === 'string' ? [fresh.metadata.tool] : [];
      if (opts.tool && toolHistory[toolHistory.length - 1] !== opts.tool) {
        toolHistory.push(opts.tool);
      }
      await this.store.update(canonical, {
        metadata: {
          ...fresh.metadata,
          resumed_by: resumedBy,
          resumed_at: new Date().toISOString(),
          tool_history: toolHistory,
          ...(opts.tool && { tool: opts.tool }),
          ...(opts.model && { model: opts.model }),
        },
      });
    } else if (!newHarnessId) {
      warnings.push(
        'No harness session id available — alias not recorded; ' +
        'new exchanges may open a new session.',
      );
    }

    const batchSummaries: ResumeBatchSummary[] = summaryNode
      ? (await this.store.getChildByKind(summaryNode.id, KIND_BATCH))
          .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index))
          .map(b => ({
            batchIndex: Number(b.metadata.batch_index),
            seqFrom: Number(b.metadata.seq_from),
            seqTo: Number(b.metadata.seq_to),
            text: b.content ?? '',
          }))
      : [];
    if (batchSummaries.length === 0) {
      warnings.push('No batch summaries yet — summarizer may be behind.');
    }

    const rawCount = opts.rawCount ?? 10;
    const exBatches = (await this.store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH))
      .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index));
    const users: Entry[] = [];
    for (const b of exBatches) {
      users.push(
        ...(await this.store.getChildrenBySeq(b.id)).filter(u => u.metadata.role === 'user'),
      );
    }
    users.sort((a, b) => Number(a.metadata.seq) - Number(b.metadata.seq));
    const recentUsers = users.slice(-rawCount);
    const recentExchanges: ResumeExchange[] = [];
    for (const u of recentUsers) {
      const replies = await this.store.getChildren(u.id);
      const agent = replies.find(r => r.metadata.role === 'agent') ?? null;
      recentExchanges.push({
        seq: Number(u.metadata.seq),
        userContent: u.content || u.title,
        agentContent: agent ? (agent.content || agent.title) : null,
      });
    }

    const freshSession = (await this.store.read(canonical))!;
    return {
      sessionId: canonical,
      sessionMeta: {
        project: typeof freshSession.metadata.project_ref === 'string'
          ? freshSession.metadata.project_ref : undefined,
        date: typeof freshSession.metadata.date === 'string'
          ? freshSession.metadata.date : undefined,
        tool: typeof freshSession.metadata.tool === 'string'
          ? freshSession.metadata.tool : undefined,
        toolHistory: Array.isArray(freshSession.metadata.tool_history)
          ? (freshSession.metadata.tool_history as string[]) : [],
        exchangeCount: typeof freshSession.metadata.exchange_count === 'number'
          ? freshSession.metadata.exchange_count : 0,
        taskSummary: typeof freshSession.metadata.task_summary === 'string'
          ? freshSession.metadata.task_summary : undefined,
      },
      sessionSummary: summaryNode?.content ?? '',
      batchSummaries,
      recentExchanges,
      warnings,
    };
  }

  async listResumableSessions(projectRef: string, limit = 10): Promise<ResumableSession[]> {
    const project = await this.store.requireProject(projectRef);
    const rows = this.store.listProjectSessionsByActivity(project.id, limit);
    const out: ResumableSession[] = [];
    for (const { id, lastActivity } of rows) {
      const session = await this.store.read(id);
      if (!session) continue;
      const summaryNode = await findChildByKind(this.store, id, KIND_SUMMARY_ROOT);
      const summaryFirstLine =
        (summaryNode?.content ?? '').split('\n').find(l => l.trim())?.trim() ?? '';
      out.push({
        sessionId: id,
        title: session.title,
        date: typeof session.metadata.date === 'string' ? session.metadata.date : undefined,
        lastActivity,
        tool: typeof session.metadata.tool === 'string' ? session.metadata.tool : undefined,
        taskSummary: typeof session.metadata.task_summary === 'string'
          ? session.metadata.task_summary : undefined,
        exchangeCount: typeof session.metadata.exchange_count === 'number'
          ? session.metadata.exchange_count : 0,
        summaryFirstLine,
      });
    }
    return out;
  }

  private static readonly PROJECT_STATS_MARKER = '## Project Stats';

  /** Refresh project-root stats line (entry count + last activity). */
  async updateProjectSummary(projectId: string): Promise<Entry> {
    const project = await this.store.requireProject(projectId);
    const stats = this.store.getProjectEntryStats(project.id);
    const statsLine = `${stats.count} entries · Last activity: ${stats.lastActivity}`;

    const existing = project.content ?? '';
    const marker = SessionManager.PROJECT_STATS_MARKER;
    const blockRe = new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n.*$`, 'm');
    const merged = blockRe.test(existing)
      ? existing.replace(blockRe, `${marker}\n${statsLine}`)
      : existing.trimEnd()
        ? `${existing.trimEnd()}\n\n${marker}\n${statsLine}`
        : `${marker}\n${statsLine}`;

    await this.store.update(project.id, {
      title: project.title,
      content: merged,
    });
    return (await this.store.read(project.id))!;
  }
}

const AUTO_PROJECT_SECTIONS = [
  { label: 'Tasks', content: 'Actionable work items and open tasks' },
  { label: 'Bugs', content: 'Bug and error tracking' },
  { label: 'Lessons', content: 'Lessons learned and pitfalls' },
  { label: 'Ideas', content: 'Brainstorming and undecided proposals' },
  { label: 'Decisions', content: 'Architecture and project decisions' },
] as const;

async function nextAutoProjectLabel(store: TimStore): Promise<string> {
  return store.allocateNextProjectLabel();
}

function isAutoProjectBlocked(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  if (resolved === home) return true;
  if (resolved === '/tmp' || resolved.startsWith('/tmp/')) return true;
  if (resolved === '/var/tmp' || resolved.startsWith('/var/tmp/')) return true;
  const tasksDir = path.join(home, 'projects', 'tasks');
  if (resolved === tasksDir || resolved.startsWith(`${tasksDir}${path.sep}`)) return true;
  return false;
}

export interface EnsureProjectForPathResult {
  label: string;
  entry: Entry;
  created: boolean;
}

/**
 * Auto-create a project from a directory name when no .tim-project binding exists.
 * Re-bind to an existing project with the same directory alias. Reversible via
 * irrelevant flag on the project root.
 */
export async function ensureProjectForPath(
  store: TimStore,
  cwd: string,
): Promise<EnsureProjectForPathResult | null> {
  const config = loadConfig();
  if (config.autoProject === false) return null;

  const resolvedPath = path.resolve(cwd);
  if (isAutoProjectBlocked(resolvedPath)) return null;

  const dirName = path.basename(resolvedPath);
  if (!dirName || dirName === '.' || dirName === '/') return null;

  const byPath = await store.findProjectByPath(resolvedPath);
  if (byPath && !byPath.irrelevant) {
    const label = typeof byPath.metadata.label === 'string' ? byPath.metadata.label : byPath.id;
    return { label, entry: byPath, created: false };
  }

  const alias = dirName.toLowerCase();
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const label = await nextAutoProjectLabel(store);
    try {
      const entry = await store.createProject(label, {
        content: `${dirName} | Active`,
        metadata: { name: dirName, path: resolvedPath, auto_created: true },
        aliases: [alias],
      });

      for (const section of AUTO_PROJECT_SECTIONS) {
        await store.write(section.content, {
          parentId: entry.id,
          metadata: { kind: 'section', label: section.label },
        });
      }

      return { label, entry, created: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts - 1 && msg.includes('already exists')) continue;
      throw err;
    }
  }

  return null;
}
