import {
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
  type TimStore,
} from 'tim-store';
import { buildNowBlock, isSubstantiveSession } from 'tim-hooks';
import type { BriefingRenderContext, RecentSessionLine } from './project-output.js';

async function sessionHandoffNote(store: TimStore, sessionId: string): Promise<boolean> {
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  const note = summaryNode?.metadata.handoff_note;
  return typeof note === 'string' && note.trim().length > 0;
}

export async function buildBriefingRenderContext(
  store: TimStore,
  projectLabel: string,
  projectId: string,
  recentSessionsCount: number,
): Promise<BriefingRenderContext> {
  const stats = store.getProjectEntryStats(projectId);
  const nowBlockLines = await buildNowBlock(store, projectLabel);

  const rows = store.listProjectSessionsByActivity(projectId, 1000);
  const totalSessionCount = rows.length;
  const showCount = totalSessionCount >= 3
    ? Math.max(3, recentSessionsCount)
    : totalSessionCount;

  const recentSessions: RecentSessionLine[] = [];
  for (const { id } of rows.slice(0, showCount)) {
    const session = await store.read(id);
    if (!session) continue;
    const summaryNode = await findChildByKind(store, id, KIND_SUMMARY_ROOT);
    const exchangeCount = Number(session.metadata.exchange_count) || 0;
    const hasHandoff = await sessionHandoffNote(store, id);
    const trivial = !isSubstantiveSession(exchangeCount, hasHandoff);
    const date = typeof session.metadata.date === 'string'
      ? session.metadata.date.slice(0, 10)
      : session.createdAt.slice(0, 10);

    if (trivial) {
      recentSessions.push({ exchanges: exchangeCount, date, summary: [], trivial: true });
      continue;
    }

    const stored = typeof summaryNode?.metadata.summary === 'string'
      ? summaryNode.metadata.summary.trim()
      : '';
    const summary = stored
      ? stored.split('\n').map(l => l.trim()).filter(Boolean)
      : [];
    recentSessions.push({ exchanges: exchangeCount, date, summary, trivial: false });
  }

  return {
    lastActivityDate: stats.lastActivity,
    nowBlockLines,
    recentSessions,
    totalSessionCount,
  };
}
