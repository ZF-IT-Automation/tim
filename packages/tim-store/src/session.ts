import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';

export type ExchangeRole = 'user' | 'agent';

export interface Exchange {
  role: ExchangeRole;
  content: string;
}

export type Summarizer = (exchanges: Entry[]) => Promise<string>;

export interface SessionStartParams {
  sessionId: string;
  agentName: string;
  cwd: string;
  harness: string;
}

const DEFAULT_SUMMARIZER: Summarizer = async (exchanges) => {
  const text = exchanges
    .map(e => {
      const role = e.metadata.role ?? 'unknown';
      return `${role}: ${e.content}`;
    })
    .join('\n');
  return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
};

export class SessionManager {
  constructor(private store: TimStore) {}

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

  async getSessionExchanges(sessionId: string): Promise<Entry[]> {
    return this.store.getChildren(sessionId, { metadataKind: 'exchange' });
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
