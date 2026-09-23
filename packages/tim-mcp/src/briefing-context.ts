import {
  SessionManager,
  findChildByKind,
  KIND_SUMMARY_ROOT,
  isSubstantiveSession,
  parseSessionSubstance,
  sessionHasHandoffNote,
  type TimStore,
} from 'tim-store';
import { buildNowBlock } from 'tim-hooks';
import type { BriefingRenderContext, RecentSessionLine } from './project-output.js';

async function sessionHandoffNote(store: TimStore, sessionId: string): Promise<boolean> {
  const summaryNode = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);
  return sessionHasHandoffNote(summaryNode?.metadata);
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
  const substantiveSessions: RecentSessionLine[] = [];
  let hiddenShortCount = 0;

  for (const { id } of rows) {
    const session = await store.read(id);
    if (!session) continue;
    const summaryNode = await findChildByKind(store, id, KIND_SUMMARY_ROOT);
    const exchangeCount = Number(session.metadata.exchange_count) || 0;
    const hasHandoff = await sessionHandoffNote(store, id);
    const substance = parseSessionSubstance(summaryNode?.metadata.substance);
    if (!isSubstantiveSession(exchangeCount, hasHandoff, substance)) {
      hiddenShortCount += 1;
      continue;
    }

    const date = typeof session.metadata.date === 'string'
      ? session.metadata.date.slice(0, 10)
      : session.createdAt.slice(0, 10);

    const stored = typeof summaryNode?.metadata.summary === 'string'
      ? summaryNode.metadata.summary.trim()
      : '';
    const summary = stored
      ? stored.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 1)
      : [];
    substantiveSessions.push({ exchanges: exchangeCount, date, summary });
  }

  const substantiveTotal = substantiveSessions.length;
  const showCount = substantiveTotal >= 3
    ? Math.max(3, recentSessionsCount)
    : substantiveTotal;

  return {
    lastActivityDate: stats.lastActivity,
    nowBlockLines,
    recentSessions: substantiveSessions.slice(0, showCount),
    totalSessionCount: substantiveTotal,
    hiddenShortSessionCount: hiddenShortCount,
  };
}
