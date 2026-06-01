import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import * as os from 'os';
import {
  DEFAULT_BATCH_SIZE,
  deriveCounters,
  EXCHANGES_NODE_TITLE,
  findChildByKind,
  getCurrentBatch,
  KIND_BATCH,
  KIND_EXCHANGE,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_SESSION,
  KIND_SESSIONS_ROOT,
  KIND_SUMMARY_ROOT,
  SESSION_SUMMARY_TAG,
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

const DEFAULT_SUMMARIZER: Summarizer = async (exchanges) => {
  const text = exchanges
    .map(e => {
      const role = e.metadata.role ?? 'unknown';
      return `${role}: ${e.content || e.title}`;
    })
    .join('\n');
  return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
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
    if (existing?.metadata.kind === KIND_SESSION) return existing;

    const project = await this.store.read(projectId);
    if (!project || project.metadata.kind !== 'project') {
      throw new Error(`Project not found: ${projectId}`);
    }

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
        summarizer: params.summarizer ?? { cli: 'claude', model: 'haiku' },
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

    let { batchNode, usersInBatch, allBatches: exchangeBatches } = await getCurrentBatch(
      this.store,
      exNode.id,
    );

    const allUserNodes: Entry[] = [];
    for (const b of exchangeBatches) {
      const users = (await this.store.getChildrenBySeq(b.id)).filter(
        u => u.metadata.role === 'user',
      );
      allUserNodes.push(...users);
    }
    let seq = allUserNodes.reduce(
      (m, u) => Math.max(m, typeof u.metadata.seq === 'number' ? u.metadata.seq : 0),
      0,
    );

    let currentUser: Entry | null = allUserNodes[allUserNodes.length - 1] ?? null;

    const written: Entry[] = [];
    for (const e of entries) {
      if (e.role === 'user') {
        if (usersInBatch.length >= batchSize) {
          const fullBatchId = batchNode.id;
          const fullBatchIndex =
            typeof batchNode.metadata.batch_index === 'number'
              ? batchNode.metadata.batch_index
              : exchangeBatches.length;
          const nextIndex = fullBatchIndex + 1;
          batchNode = await this.store.write(`Batch ${nextIndex}`, {
            parentId: exNode.id,
            metadata: { kind: KIND_EXCHANGE_BATCH, batch_index: nextIndex, order: nextIndex },
          });
          usersInBatch = [];
          this.onBatchFull?.({
            sessionId,
            batchId: fullBatchId,
            batchIndex: fullBatchIndex,
          });
        }
        seq += 1;
        currentUser = await this.store.write(e.content, {
          parentId: batchNode.id,
          metadata: { kind: KIND_EXCHANGE, role: 'user', seq, sessionId },
          tags: ['#exchange'],
        });
        usersInBatch.push(currentUser);
        written.push(currentUser);
      } else {
        const parentId = currentUser ? currentUser.id : batchNode.id;
        const agentSeq = currentUser ? currentUser.metadata.seq : seq;
        const a = await this.store.write(e.content, {
          parentId,
          metadata: { kind: KIND_EXCHANGE, role: 'agent', seq: agentSeq, sessionId },
          tags: ['#exchange'],
        });
        written.push(a);
      }
    }

    const { exchangeCount } = await deriveCounters(this.store, sessionId);
    await this.store.update(sessionId, {
      metadata: { ...session.metadata, exchange_count: exchangeCount },
    });

    return written;
  }

  async showUnsummarized(sessionId: string): Promise<UnsummarizedBatch> {
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
    const batchIndex = batchesSummarized + 1;

    const exchangeBatches = await this.store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH);
    const batchNode =
      exchangeBatches.find(b => b.metadata.batch_index === batchIndex) ?? null;

    const exchanges: UnsummarizedExchange[] = [];
    if (batchNode) {
      const users = (await this.store.getChildrenBySeq(batchNode.id)).filter(
        u => u.metadata.role === 'user',
      );
      for (const u of users) {
        const replies = await this.store.getChildren(u.id);
        const agent = replies.find(r => r.metadata.role === 'agent') ?? null;
        exchanges.push({
          seq: Number(u.metadata.seq),
          userId: u.id,
          userContent: u.content || u.title,
          agentId: agent?.id ?? null,
          agentContent: agent ? (agent.content || agent.title) : null,
        });
      }
    }

    const hasMore = exchangeBatches.some(
      b => b.metadata.batch_index === batchIndex + 1,
    );

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
  ): Promise<Entry> {
    const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
    if (!summaryNode) throw new Error(`Summary node missing for session: ${sessionId}`);

    const existing = (await this.store.getChildByKind(summaryNode.id, KIND_BATCH))
      .find(b => b.metadata.batch_index === batchIndex);
    if (existing) return existing;

    const summarizedAt = new Date().toISOString();
    const node = await this.store.write(summaryText, {
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
      tags: [SESSION_SUMMARY_TAG, '#batch-summary'],
    });

    const session = await this.store.read(sessionId);
    const { batchesSummarized } = await deriveCounters(this.store, sessionId);
    if (session) {
      await this.store.update(sessionId, {
        metadata: { ...session.metadata, batches_summarized: batchesSummarized },
      });
    }
    return node;
  }

  async rollUpSession(
    sessionId: string,
    fold: (batches: Entry[]) => Promise<string>,
  ): Promise<Entry> {
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
    opts: { summarize?: Summarizer; runDecay?: boolean } = {},
  ): Promise<Entry> {
    const session = await this.store.read(sessionId);
    if (!session || session.metadata.kind !== 'session') {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const exchanges = await this.getSessionExchanges(sessionId);
    const summarize = opts.summarize ?? DEFAULT_SUMMARIZER;
    const summaryText = await summarize(exchanges);

    const summary = await this.store.write(summaryText, {
      metadata: {
        kind: 'checkpoint',
        sessionId,
        count: exchanges.length,
      },
      tags: ['#checkpoint'],
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

    if (opts.runDecay !== false) {
      await this.store.runDecay({
        before: session.createdAt,
        exclude: [sessionId, summary.id],
      });
    }

    return summary;
  }
}
